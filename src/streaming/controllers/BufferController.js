/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */

import FragmentModel from '../models/FragmentModel';
import MediaPlayerModel from '../models/MediaPlayerModel';
import SourceBufferController from './SourceBufferController';
import AbrController from './AbrController';
import PlaybackController from './PlaybackController';
import MediaController from './MediaController';
import EventBus from '../../core/EventBus';
import Events from '../../core/events/Events';
import BoxParser from '../utils/BoxParser';
import FactoryMaker from '../../core/FactoryMaker';
import Debug from '../../core/Debug';
import InitCache from '../utils/InitCache';

const BUFFER_LOADED = 'bufferLoaded';
const BUFFER_EMPTY = 'bufferStalled';
const STALL_THRESHOLD = 0.5;
//VUDU Rik - removing anything smaller than a frame will fail.  Don't attempt anything smaller than two frames
const REMOVE_MINIMUM = 2 / 30;

function BufferController(config) {

    const context = this.context;
    const log = Debug(context).getInstance().log;
    const eventBus = EventBus(context).getInstance();
    const metricsModel = config.metricsModel;
    const manifestModel = config.manifestModel;
    const sourceBufferController = config.sourceBufferController;
    const errHandler = config.errHandler;
    const streamController = config.streamController;
    const mediaController = config.mediaController;
    const adapter = config.adapter;
    const textSourceBuffer = config.textSourceBuffer;


    let instance,
        requiredQuality,
        isBufferingCompleted,
        bufferLevel,
        criticalBufferLevel,
        mediaSource,
        maxAppendedIndex,
        lastIndex,
        type,
        buffer,
        bufferState,
        appendedBytesInfo,
        wallclockTicked,
        appendingMediaChunk,
        isAppendingInProgress,
        isPruningInProgress,
        inbandEventFound,
        playbackController,
        streamProcessor,
        abrController,
        scheduleController,
        mediaPlayerModel,
        initCache;

    function setup() {
        requiredQuality = AbrController.QUALITY_DEFAULT;
        isBufferingCompleted = false;
        bufferLevel = 0;
        criticalBufferLevel = Number.POSITIVE_INFINITY;
        maxAppendedIndex = 0;
        lastIndex = 0;
        buffer = null;
        bufferState = BUFFER_EMPTY;
        wallclockTicked = 0;
        appendingMediaChunk = false;
        isAppendingInProgress = false;
        isPruningInProgress = false;
        inbandEventFound = false;
    }

    function initialize(Type, Source, StreamProcessor) {
        type = Type;
        setMediaSource(Source);
        streamProcessor = StreamProcessor;
        mediaPlayerModel = MediaPlayerModel(context).getInstance();
        playbackController = PlaybackController(context).getInstance();
        abrController = AbrController(context).getInstance();
        initCache = InitCache(context).getInstance();
        scheduleController = streamProcessor.getScheduleController();
        requiredQuality = abrController.getQualityFor(type, streamProcessor.getStreamInfo());

        eventBus.on(Events.DATA_UPDATE_COMPLETED, onDataUpdateCompleted, this);
        eventBus.on(Events.INIT_FRAGMENT_LOADED, onInitFragmentLoaded, this);
        eventBus.on(Events.MEDIA_FRAGMENT_LOADED, onMediaFragmentLoaded, this);
        eventBus.on(Events.QUALITY_CHANGE_REQUESTED, onQualityChanged, this);
        eventBus.on(Events.STREAM_COMPLETED, onStreamCompleted, this);
        eventBus.on(Events.PLAYBACK_PROGRESS, onPlaybackProgression, this);
        eventBus.on(Events.PLAYBACK_TIME_UPDATED, onPlaybackProgression, this);
        eventBus.on(Events.PLAYBACK_RATE_CHANGED, onPlaybackRateChanged, this);
        eventBus.on(Events.PLAYBACK_SEEKING, onPlaybackSeeking, this);
        eventBus.on(Events.WALLCLOCK_TIME_UPDATED, onWallclockTimeUpdated, this);
        eventBus.on(Events.CURRENT_TRACK_CHANGED, onCurrentTrackChanged, this, EventBus.EVENT_PRIORITY_HIGH);
        eventBus.on(Events.SOURCEBUFFER_APPEND_COMPLETED, onAppended, this);
        eventBus.on(Events.SOURCEBUFFER_REMOVE_COMPLETED, onRemoved, this);

        criticalBufferLevel = mediaPlayerModel.getCriticalBufferDefault();
    }

    function createBuffer(mediaInfo) {
        if (!mediaInfo || !mediaSource || !streamProcessor) return null;

        let sourceBuffer = null;

        try {
            sourceBuffer = sourceBufferController.createSourceBuffer(mediaSource, mediaInfo);

            if (sourceBuffer && sourceBuffer.hasOwnProperty('initialize')) {
                sourceBuffer.initialize(type, this);
            }
        } catch (e) {
            errHandler.mediaSourceError('Error creating ' + type + ' source buffer.');
        }
        setBuffer(sourceBuffer);
        updateBufferTimestampOffset(streamProcessor.getRepresentationInfoForQuality(requiredQuality).MSETimeOffset);
        return sourceBuffer;
    }

    function isActive() {
        return streamProcessor.getStreamInfo().id === streamController.getActiveStreamInfo().id;
    }

    function onInitFragmentLoaded(e) {
        if (e.fragmentModel !== streamProcessor.getFragmentModel()) return;
        log('[' + type + '] Init fragment finished loading saving to', type + '\'s init cache');
        initCache.save(e.chunk);
        appendToBuffer(e.chunk);
    }

    function switchInitData(streamId, quality) {
        const chunk = initCache.extract(streamId, type, quality);
        if (chunk) {
            appendToBuffer(chunk);
        } else {
            eventBus.trigger(Events.INIT_REQUESTED, {sender: instance});
        }
    }

    function onMediaFragmentLoaded(e) {
        if (e.fragmentModel !== streamProcessor.getFragmentModel()) return;

        const chunk = e.chunk;
        const bytes = chunk.bytes;
        const quality = chunk.quality;
        const currentRepresentation = streamProcessor.getRepresentationInfoForQuality(quality);
        const manifest = manifestModel.getValue();
        const eventStreamMedia = adapter.getEventsFor(manifest, currentRepresentation.mediaInfo, streamProcessor);
        const eventStreamTrack = adapter.getEventsFor(manifest, currentRepresentation, streamProcessor);

        if (eventStreamMedia.length > 0 || eventStreamTrack.length > 0) {
            const request = streamProcessor.getFragmentModel().getRequests({
                state: FragmentModel.FRAGMENT_MODEL_EXECUTED,
                quality: quality,
                index: chunk.index
            })[0];
            const events = handleInbandEvents(bytes, request, eventStreamMedia, eventStreamTrack);
            streamProcessor.getEventController().addInbandEvents(events);
        }

        chunk.bytes = deleteInbandEvents(bytes);
        appendToBuffer(chunk);

        const request = streamProcessor.getFragmentModel().getRequests({
            state: FragmentModel.FRAGMENT_MODEL_EXECUTED,
            quality: quality,
            index: chunk.index
        })[0];
        eventBus.trigger(Events.REPORT_DOWNLOADED_FRAGMENT_STAT,
            {
                mediaType: type,
                data: {
                    startDate: request.requestStartDate,
                    endDate: request.requestEndDate,
                    index: chunk.index,
                    quality: chunk.quality,
                    duration: chunk.duration,
                    bytes: chunk.bytes.byteLength
                }
            }
        );
    }


    function appendToBuffer(chunk) {
        isAppendingInProgress = true;
        //Vudu Eric only for Tizen 2.x platform which use webkit2 as browser engine for 2016 TV
        //if we append 2 Init segment side by side, insert an abort() call between them
        if (appendedBytesInfo && isNaN(appendedBytesInfo.index) && isNaN(chunk.index)) {
            //if (navigator.userAgent.indexOf('Tizen 2.2') !== -1 || navigator.userAgent.indexOf('Tizen 2.4') !== -1) {
            //sourceBufferController.abort(mediaSource, buffer);
            log('[' + type + '] Warning Append 2 init segment side by side!!');
            //}
        }
        appendedBytesInfo = chunk;
        sourceBufferController.append(buffer, chunk);

        if (chunk.mediaInfo.type === 'video') {
            if (chunk.mediaInfo.embeddedCaptions) {
                textSourceBuffer.append(chunk.bytes, chunk);
            }
        }
    }

    let pendingClearTimer = null;
    function onAppended(e) {
        if (buffer !== e.buffer) return;

        if (!!e.error || !hasEnoughSpaceToAppend()) {
            let haveSpace = hasEnoughSpaceToAppend();
            if (!!e.error) log('[', type, '] onAppended - error during append: ', e.error.code);
            if (!haveSpace) log('[', type, '] onAppended - not enough space to append');
            if (!!e.error && e.error.code === SourceBufferController.QUOTA_EXCEEDED_ERROR_CODE) {
                criticalBufferLevel = sourceBufferController.getTotalBufferedTime(buffer) * 0.8;
                if (criticalBufferLevel < mediaPlayerModel.getCriticalBufferMinimum()) {
                    // TODO - maybe throw an out of memory error here?
                    log('WARN: criticalBufferLevel cannot go below prescribed minimum');
                    criticalBufferLevel = mediaPlayerModel.getCriticalBufferMinimum();
                }

                // Adjust the ranges of buffer that we keep.
                let newBufferKeep = 0.1 * criticalBufferLevel | 0; // int
                newBufferKeep = Math.max(newBufferKeep, 1); // ensure > zero
                let newBufferAhead = (criticalBufferLevel - newBufferKeep) | 0; // rest of buffer, int
                mediaPlayerModel.setBufferToKeep(newBufferKeep);
                mediaPlayerModel.setBufferAheadToKeep(newBufferAhead);

                log('[', type, '] Updated buffer ranges -- criticalBufferLevel: ', criticalBufferLevel, '; bufferKeep: ', newBufferKeep, '; bufferKeepAhead: ', newBufferAhead);
            }
            if ( (!!e.error && e.error.code === SourceBufferController.QUOTA_EXCEEDED_ERROR_CODE) || !haveSpace ) {
                eventBus.trigger(Events.QUOTA_EXCEEDED, {sender: instance, criticalBufferLevel: criticalBufferLevel}); //Tells ScheduleController to stop scheduling.

                // VUDU Rik - Sometimes this removal fails.  For example, no data ahead of playback position, or range < one sample - so cannot be removed
                // Add check here for range, and if nothing to remove, reschedule for a second from now.  This works around some 'spinning' on the removal
                // which we were seeing if we just blindly attempt to remove small ranges.
                const performRemove = (function onappend_performremove(pendingDuration) {
                    if (null !== pendingClearTimer) {
                        log('performRemove already pending');
                        return;
                    }

                    const ranges = getClearRanges();
                    let haveRemovableRanges = false;
                    if ( !!ranges && (0 !== ranges.length) ) {
                        haveRemovableRanges = ranges.some(function (item) {
                            if ( (item.end - item.start) >= REMOVE_MINIMUM ) {
                                return true;
                            }
                        });
                    }
                    if (haveRemovableRanges) {
                        // Then we clear the buffer and onCleared event will tell ScheduleController to start scheduling again.
                        clearBufferRanges(ranges);
                    }
                    else {
                        pendingClearTimer = setTimeout(function onappend_performpendingremove() {
                            pendingClearTimer = null;
                            performRemove(pendingDuration);
                        }, pendingDuration * 1000);
                    }
                });
                // FIXME: Hard coded '4' should be replaced.
                performRemove(Math.max(4, appendedBytesInfo.duration));
            }
            return;
        }

        if (!isNaN(appendedBytesInfo.index)) {
            maxAppendedIndex = Math.max(appendedBytesInfo.index, maxAppendedIndex);
            checkIfBufferingCompleted();
        }

        const ranges = sourceBufferController.getAllRanges(buffer);
        log('[', type, '] onAppended()');
        if (ranges && ranges.length > 0) {
            log(' - Ranges present: ', ranges.length);
            for (let i = 0, len = ranges.length; i < len; i++) {
                log('[', type, '] - Buffered Range : [ ', ranges.start(i) ,  ' - ' ,  ranges.end(i) , ' ] ' + (ranges.end(i) - ranges.start(i)) + ' currentTime = ' + playbackController.getTime());
            }
        }
        else {
            log('[', type, '] - Buffered Range : (no buffered ranges)');
        }

        onPlaybackProgression();
        isAppendingInProgress = false;
        eventBus.trigger(Events.BYTES_APPENDED, {
            sender: instance,
            quality: appendedBytesInfo.quality,
            startTime: appendedBytesInfo.start,
            index: appendedBytesInfo.index,
            bufferedRanges: ranges
        });
    }

    function onQualityChanged(e) {
        if (requiredQuality === e.newQuality || type !== e.mediaType || streamProcessor.getStreamInfo().id !== e.streamInfo.id) return;

        updateBufferTimestampOffset(streamProcessor.getRepresentationInfoForQuality(e.newQuality).MSETimeOffset);
        requiredQuality = e.newQuality;
    }

    //**********************************************************************
    // START Buffer Level, State & Sufficiency Handling.
    //**********************************************************************
    function onPlaybackSeeking() {
        lastIndex = 0;
        isBufferingCompleted = false;

        // VUDU RIK - seek may result in a large amount of unnecessary buffered content.
        // remove data outside the play-head range.

        if ('fragmentedText' !== type) {
            // Remove everything, except the fragment for the playback time
            const currentTime = playbackController.getTime();
            const duration = streamProcessor.getStreamInfo().duration;

            let req = streamProcessor.getFragmentModel().getRequests({state: FragmentModel.FRAGMENT_MODEL_EXECUTED, time: currentTime})[0];
            if (!req) {
                clearBuffer({start: 0, end: duration});
            }
            else {
                let beforeRange = {
                    start: 0,
                    end: req.startTime - 0.5
                };

                let afterRange = {
                    start: req.starTime + req.duration + 0.5,
                    end: duration
                };

                req = streamProcessor.getFragmentModel().getRequests({state: FragmentModel.FRAGMENT_MODEL_EXECUTED, time: req.starTime + req.duration})[0];
                if (!!req) {
                    let extendedKeepEnd = req.startTime + req.duration + 0.5;
                    if ( (extendedKeepEnd - beforeRange.end) < criticalBufferLevel) {
                        afterRange.start = extendedKeepEnd;
                    }
                }

                clearBufferRanges([
                    beforeRange,
                    afterRange
                ]);
            }
        }

        onPlaybackProgression();
    }

    function onPlaybackProgression() {
        updateBufferLevel();
        addBufferMetrics();
    }

    function updateBufferLevel() {
        bufferLevel = sourceBufferController.getBufferLength(buffer, playbackController.getTime());
        eventBus.trigger(Events.BUFFER_LEVEL_UPDATED, {sender: instance, bufferLevel: bufferLevel});
        checkIfSufficientBuffer();
    }

    function addBufferMetrics() {
        if (!isActive()) return;
        metricsModel.addBufferState(type, bufferState, scheduleController.getBufferTarget());
        metricsModel.addBufferLevel(type, new Date(), bufferLevel * 1000);
    }

    function checkIfBufferingCompleted() {
        const isLastIdxAppended = maxAppendedIndex === (lastIndex - 1);
        if (isLastIdxAppended && !isBufferingCompleted) {
            isBufferingCompleted = true;
            eventBus.trigger(Events.BUFFERING_COMPLETED, {sender: instance, streamInfo: streamProcessor.getStreamInfo()});
        }
    }

    function checkIfSufficientBuffer() {
        //log('[' + type + ']' + ' bufferLevel = ' + bufferLevel + ', bufferState = ' + bufferState + ', currentTime = ' + playbackController.getTime());
        if (bufferLevel < STALL_THRESHOLD && !isBufferingCompleted) {
            notifyBufferStateChanged(BUFFER_EMPTY);
        } else {
            if (isBufferingCompleted) {
                notifyBufferStateChanged(BUFFER_LOADED);
                return;
            }
            //Vudu Eric, after bufferunderrun, only both audio/video accumulate more than 6 seconds then notify new buffered state
            // FIXME: Shouldn't be a hardcoded '6'.
            if (bufferLevel >= 6) {
                notifyBufferStateChanged(BUFFER_LOADED);
            }
        }
    }

    function notifyBufferStateChanged(state) {
        if (bufferState === state || (type === 'fragmentedText' && textSourceBuffer.getAllTracksAreDisabled())) return;
        bufferState = state;
        addBufferMetrics();
        eventBus.trigger(Events.BUFFER_LEVEL_STATE_CHANGED, {sender: instance, state: state, mediaType: type, streamInfo: streamProcessor.getStreamInfo()});
        eventBus.trigger(state === BUFFER_LOADED ? Events.BUFFER_LOADED : Events.BUFFER_EMPTY, {mediaType: type});
        log(state === BUFFER_LOADED ? '[' + type + '] Got enough buffer to start.' : '[' + type + '] Waiting for more buffer before starting playback.');
    }


    function handleInbandEvents(data, request, mediaInbandEvents, trackInbandEvents) {

        const fragmentStartTime = Math.max(isNaN(request.startTime) ? 0 : request.startTime, 0);
        const eventStreams = [];
        const events = [];

        inbandEventFound = false; //TODO Discuss why this is hear!
        /* Extract the possible schemeIdUri : If a DASH client detects an event message box with a scheme that is not defined in MPD, the client is expected to ignore it */
        const inbandEvents = mediaInbandEvents.concat(trackInbandEvents);
        for (let i = 0, ln = inbandEvents.length; i < ln; i++) {
            eventStreams[inbandEvents[i].schemeIdUri] = inbandEvents[i];
        }

        const isoFile = BoxParser(context).getInstance().parse(data);
        const eventBoxes = isoFile.getBoxes('emsg');

        for (let i = 0, ln = eventBoxes.length; i < ln; i++) {
            const event = adapter.getEvent(eventBoxes[i], eventStreams, fragmentStartTime);

            if (event) {
                events.push(event);
            }
        }

        return events;
    }

    function deleteInbandEvents(data) {

        if (!inbandEventFound) { //TODO Discuss why this is here. inbandEventFound is never set to true!!
            return data;
        }

        const length = data.length;
        const expTwo = Math.pow(256, 2);
        const expThree = Math.pow(256, 3);
        const modData = new Uint8Array(data.length);

        let i = 0;
        let j = 0;

        while (i < length) {

            let identifier = String.fromCharCode(data[i + 4],data[i + 5],data[i + 6],data[i + 7]);
            let size = data[i] * expThree + data[i + 1] * expTwo + data[i + 2] * 256 + data[i + 3] * 1;

            if (identifier != 'emsg' ) {
                for (let l = i ; l < i + size; l++) {
                    modData[j] = data[l];
                    j++;
                }
            }
            i += size;

        }

        return modData.subarray(0, j);
    }

    function hasEnoughSpaceToAppend() {
        var totalBufferedTime = sourceBufferController.getTotalBufferedTime(buffer);
        //log('totalBufferedTime: ', totalBufferedTime, '; criticalBufferLevel: ', criticalBufferLevel);
        return (totalBufferedTime < criticalBufferLevel);
    }

    /* prune buffer on our own to avoid browsers pruning buffer silently */
    function pruneBufferWindow() {
        if (type === 'fragmentedText') return;
        if (!isBufferingCompleted) {
            clearBufferRanges(getClearRanges());
        }
    }


    /**
    This will return an array of two buffer ranges.  One is data before the current playback 'window',
    the second is data ahead of the current playback window - outside of the keep ahead range.
    */
    function getClearRanges() {
        let ret = [];

        let pastRange = {};
        let futRange = {};

        if (!buffer || !buffer.buffered || (0 === buffer.buffered.length)) {
            return ret;
        }

        // we need to remove data that is more than one fragment before the playback currentTime, or maxbuffer ahead of currentTime
        const currentTime = playbackController.getTime();
        const ranges = buffer.buffered;

        let keepRange = {
            start: Math.max(0, currentTime - mediaPlayerModel.getBufferToKeep()),
            end: currentTime + mediaPlayerModel.getBufferAheadToKeep()
        };

        // VUDU Rik - add explicit tolerance, to reduce likelihood of pruning wrong fragment.
        const req = streamProcessor.getFragmentModel().getRequests({state: FragmentModel.FRAGMENT_MODEL_EXECUTED, time: currentTime, threshold: REMOVE_MINIMUM})[0];

        // If the keep range is likely to trim the current fragment, then extend keeprange to include all the current fragment.
        if (!!req) {
            log('Verifying keep range against current fragment -- keepRange: ', JSON.stringify(keepRange), '; frag req (start-end): ', req.startTime, '-', req.startTime + req.duration);
            keepRange.start = Math.min(req.startTime, keepRange.start);
            keepRange.end = Math.max(req.startTime + req.duration, keepRange.end);
        }

        log('[', type, '] getClearRanges() removing everything outside: [ ', keepRange.start, ' - ', keepRange.end, ' ]');


        let rangeIdx = 0;
        if (ranges.start(0) <= keepRange.start) {
            // TODO: could I just set this to 'zero' (0) ?
            pastRange.start = Math.max(0, ranges.start(0) - 0.5); // extend range slightly to ensure no slivers are left
            // Default to start of buffer, but may back off if buffer is not contiguous.
            pastRange.end = keepRange.start;
            for (; rangeIdx !== ranges.length && (ranges.end(rangeIdx) <= keepRange.start); ++rangeIdx) {
                pastRange.end = ranges.end(rangeIdx);
            }

            log('past range: ', JSON.stringify(pastRange));
            if (pastRange.end > pastRange.start) ret.push(pastRange);
        }

        if (ranges.end(ranges.length - 1) >= keepRange.end) {
            futRange.end = ranges.end(ranges.length - 1) + 0.5; // extended range to ensure no 'sliver' is left.
            futRange.start = keepRange.end;

            log('future range: ', JSON.stringify(futRange));
            if (futRange.end > futRange.start) ret.push(futRange);
        }

        ret.forEach(function (range) {
            log('[', type, '] getClearRanges() removing : [ ', range.start, ' - ', range.end, ' ]');
        });

        return ret;
    }

    function getClearRange() {

        if (!buffer) return null;
        if (!buffer.buffered || (0 === buffer.buffered.length)) return null;

        // we need to remove data that is more than one fragment before the video currentTime
        const currentTime = playbackController.getTime();
        // VUDU Rik - add explicit tolerance, to reduce likelihood of pruning wrong fragment.
        const req = streamProcessor.getFragmentModel().getRequests({state: FragmentModel.FRAGMENT_MODEL_EXECUTED, time: currentTime, threshold: REMOVE_MINIMUM})[0];
        const range = sourceBufferController.getBufferRange(buffer, currentTime);

        let removeStart = buffer.buffered.start(0);
        let removeEnd = (req && !isNaN(req.startTime)) ? req.startTime : Math.floor(currentTime);
        if ((range === null) && (buffer.buffered.length > 0)) {
            // VUDU Rik: Annotating non-obvious code ;)
            // range === null => req hasn't been put in buffer yet, so set removeEnd to end of MSE buffer instead.
            removeEnd = buffer.buffered.end(buffer.buffered.length - 1 );
        }

        if ( (removeStart <= currentTime) && (removeEnd >= currentTime) ) {
            // VUDU Rik.
            // Don't allow remove range to enclose current time.  Shouldn't be an issue,
            // but can occur if sourcebuffercontroller 'merges' ranges before and after currentTime.
            // FIXME: getRequests() merge logic is problematic.
            removeEnd = Math.floor(currentTime);
        }

        return {start: removeStart, end: removeEnd};
    }

    function clearBuffer(range) {
        if (!range) return;
        clearBufferRanges([range]);
    }

    let pendingClearRanges = [];
    let isClearInProgress = false;
    function clearBufferRanges(ranges) {
        if (!ranges || !buffer || (0 === ranges.length) ) return;

        pendingClearRanges.push.apply(pendingClearRanges, ranges);

        if (isClearInProgress) {
            log('[', type, '] clearBufferRanges() - clear already in progress.  Appended ', ranges.length);
            return;
        }

        clearNextRange();
    }

    function clearNextRange() {
        if (!pendingClearRanges || 0 === pendingClearRanges.length) throw new Error('Pending ranges must be non-zero here.');

        const range = pendingClearRanges.shift();

        log('[', type, '] clearNextRange(range): [ ', range.start, ' - ', range.end, ' ]');
        isClearInProgress = true;
        sourceBufferController.remove(buffer, range.start, range.end, mediaSource);
    }

    function onRemoved(e) {
        if (buffer !== e.buffer) return;

        if (0 === pendingClearRanges.length) {
            isClearInProgress = false;
        }

        if (!isClearInProgress) {
            isPruningInProgress = false;
        }

        updateBufferLevel();

        const ranges = sourceBufferController.getAllRanges(buffer);
        log('[', type, ']  onRemoved()');
        if (!ranges || (0 === ranges.length)) {
            log('[', type, '] onRemoved() Buffered Range : is empty [ 0 - 0 ]');
        }
        else {
            log('[', type, '] - Ranges present: ', ranges.length);
            for (let i = 0, len = ranges.length; i < len; i++) {
                log('[', type, '] - Remaining buffered Range : [ ',
                    ranges.start(i) ,  ' - ' ,  ranges.end(i) , ' ] ',
                    (ranges.end(i) - ranges.start(i)),
                    ' currentTime: ', playbackController.getTime());
            }
        }

        if (isClearInProgress) {
            clearNextRange();
        }
        else {
            // FIXME - from and to values here only indicate what's been cleared from the last range.  Only the last range in the list will be signalled.
            eventBus.trigger(Events.BUFFER_CLEARED, {sender: instance, from: e.from, to: e.to, hasEnoughSpaceToAppend: hasEnoughSpaceToAppend()});
        }

        //TODO - REMEMBER removed a timerout hack calling clearBuffer after manifestInfo.minBufferTime * 1000 if !hasEnoughSpaceToAppend() Aug 04 2016
    }

    function updateBufferTimestampOffset(MSETimeOffset) {
        // Each track can have its own @presentationTimeOffset, so we should set the offset
        // if it has changed after switching the quality or updating an mpd
        if (buffer && buffer.timestampOffset !== MSETimeOffset && !isNaN(MSETimeOffset)) {
            buffer.timestampOffset = MSETimeOffset;
        }
    }

    function onDataUpdateCompleted(e) {
        if (e.sender.getStreamProcessor() !== streamProcessor || e.error) return;
        updateBufferTimestampOffset(e.currentRepresentation.MSETimeOffset);
    }

    function onStreamCompleted(e) {
        if (e.fragmentModel !== streamProcessor.getFragmentModel()) return;
        lastIndex = e.request.index;

        log('[',type,'] streamCompleted at index: ', lastIndex);
        eventBus.trigger(Events.REPORT_DOWNLOADED_FRAGMENT_STAT, {mediaType: type, data: null});

        checkIfBufferingCompleted();
    }

    function onCurrentTrackChanged(e) {
        if (!buffer || (e.newMediaInfo.type !== type) || (e.newMediaInfo.streamInfo.id !== streamProcessor.getStreamInfo().id)) return;
        if (mediaController.getSwitchMode(type) === MediaController.TRACK_SWITCH_MODE_ALWAYS_REPLACE) {
            clearBuffer(getClearRange());
        }
    }

    function onWallclockTimeUpdated() {
        wallclockTicked++;
        const secondsElapsed = (wallclockTicked * (mediaPlayerModel.getWallclockTimeUpdateInterval() / 1000));
        if ((secondsElapsed >= mediaPlayerModel.getBufferPruningInterval()) && !isAppendingInProgress) {
            wallclockTicked = 0;
            pruneBufferWindow();

        }
    }

    function onPlaybackRateChanged() {
        checkIfSufficientBuffer();
    }

    function getType() {
        return type;
    }

    function getStreamProcessor() {
        return streamProcessor;
    }

    function setStreamProcessor(value) {
        streamProcessor = value;
    }

    function getBuffer() {
        return buffer;
    }

    function setBuffer(value) {
        buffer = value;
    }

    function getBufferLevel() {
        return bufferLevel;
    }

    function getCriticalBufferLevel() {
        return criticalBufferLevel;
    }

    function setMediaSource(value) {
        mediaSource = value;
    }

    function getMediaSource() {
        return mediaSource;
    }

    function getIsBufferingCompleted() {
        return isBufferingCompleted;
    }

    function reset(errored) {

        eventBus.off(Events.DATA_UPDATE_COMPLETED, onDataUpdateCompleted, this);
        eventBus.off(Events.QUALITY_CHANGE_REQUESTED, onQualityChanged, this);
        eventBus.off(Events.INIT_FRAGMENT_LOADED, onInitFragmentLoaded, this);
        eventBus.off(Events.MEDIA_FRAGMENT_LOADED, onMediaFragmentLoaded, this);
        eventBus.off(Events.STREAM_COMPLETED, onStreamCompleted, this);
        eventBus.off(Events.CURRENT_TRACK_CHANGED, onCurrentTrackChanged, this);
        eventBus.off(Events.PLAYBACK_PROGRESS, onPlaybackProgression, this);
        eventBus.off(Events.PLAYBACK_TIME_UPDATED, onPlaybackProgression, this);
        eventBus.off(Events.PLAYBACK_RATE_CHANGED, onPlaybackRateChanged, this);
        eventBus.off(Events.PLAYBACK_SEEKING, onPlaybackSeeking, this);
        eventBus.off(Events.WALLCLOCK_TIME_UPDATED, onWallclockTimeUpdated, this);
        eventBus.off(Events.SOURCEBUFFER_APPEND_COMPLETED, onAppended, this);
        eventBus.off(Events.SOURCEBUFFER_REMOVE_COMPLETED, onRemoved, this);

        criticalBufferLevel = Number.POSITIVE_INFINITY;
        bufferState = BUFFER_EMPTY;
        requiredQuality = AbrController.QUALITY_DEFAULT;
        lastIndex = 0;
        maxAppendedIndex = 0;
        appendedBytesInfo = null;
        appendingMediaChunk = false;
        isBufferingCompleted = false;
        isAppendingInProgress = false;
        isPruningInProgress = false;
        playbackController = null;
        streamProcessor = null;
        abrController = null;
        scheduleController = null;

        if (!errored) {
            sourceBufferController.abort(mediaSource, buffer);
            sourceBufferController.removeSourceBuffer(mediaSource, buffer);
        }

        buffer = null;
    }

    instance = {
        initialize: initialize,
        createBuffer: createBuffer,
        getType: getType,
        getStreamProcessor: getStreamProcessor,
        setStreamProcessor: setStreamProcessor,
        getBuffer: getBuffer,
        setBuffer: setBuffer,
        getBufferLevel: getBufferLevel,
        getCriticalBufferLevel: getCriticalBufferLevel,
        setMediaSource: setMediaSource,
        getMediaSource: getMediaSource,
        getIsBufferingCompleted: getIsBufferingCompleted,
        switchInitData: switchInitData,
        reset: reset
    };

    setup();
    return instance;
}

BufferController.__dashjs_factory_name = 'BufferController';
const factory = FactoryMaker.getClassFactory(BufferController);
factory.BUFFER_LOADED = BUFFER_LOADED;
factory.BUFFER_EMPTY = BUFFER_EMPTY;
export default factory;
