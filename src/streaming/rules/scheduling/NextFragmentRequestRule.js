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
import Debug from '../../../core/Debug';
import PlaybackController from '../../controllers/PlaybackController';
import FactoryMaker from '../../../core/FactoryMaker';

function NextFragmentRequestRule(config) {

    const context = this.context;
    const log = Debug(context).getInstance().log;
    const adapter = config.adapter;
    const sourceBufferController = config.sourceBufferController;
    const textSourceBuffer = config.textSourceBuffer;

    let playbackController;

    function setup() {
        playbackController = PlaybackController(context).getInstance();
    }

    function execute(streamProcessor, requestToReplace) {

        const representationInfo = streamProcessor.getCurrentRepresentationInfo();
        const mediaInfo = representationInfo.mediaInfo;
        const mediaType = mediaInfo.type;
        const scheduleController = streamProcessor.getScheduleController();
        const seekTarget = scheduleController.getSeekTarget();
        const hasSeekTarget = !isNaN(seekTarget);
        const buffer = streamProcessor.getBuffer();
        const playbackTime = playbackController.getTime();

        let time = hasSeekTarget ? seekTarget : adapter.getIndexHandlerTime(streamProcessor);
        let hasTimeAdjusted = false;

        if (isNaN(time) || (mediaType === 'fragmentedText' && textSourceBuffer.getAllTracksAreDisabled())) {
            return null;
        }

        if (hasSeekTarget) {
            if (!!requestToReplace) {
                // VUDU Rik - This situtation occurs if there's a quality switch around the same time that there's seek.
                log('[', mediaType, '] WARN: Performing replace in NextFragmentRule, but seek has been requested.  Preserving seek target until next time');
            }
            else {
                scheduleController.setSeekTarget(NaN);
            }
        }

        /**
         * This is critical for IE/Safari/EDGE
         * */
        if (buffer) {
            const range = sourceBufferController.getBufferRange(buffer, time);
            if (range !== null) {
                log('[' + mediaType + '] Prior to making a request for time, NextFragmentRequestRule is aligning index handler\'s currentTime with bufferedRange.end.', time, ' was changed to ', range.end);
                if (Math.abs(range.end - time) > 0.5) {
                    hasTimeAdjusted = true;
                }
                time = range.end;
            }
        }

        // VUDU Rik - Check here to see if there's any gap between the current playback position buffer, and the head of the buffer where we're appending
        // if the buffer is not contiguous between the two, then either we have trimmed, or the platform has silently trimmed.
        if (buffer && !hasSeekTarget && !isNaN(playbackTime) && (time > playbackTime)) {
            log('[', mediaType, '] time > playbackTime');

            const range = sourceBufferController.getBufferRange(buffer, playbackTime, null /*tolerance*/);
            if (null === range) {
                log('[', mediaType, '] playbackTime range === null');
                // Need to establish buffer at playback time!
                time = playbackTime;
                // RIK - is this 'hasTimeAdjusted' idea really correct?
                hasTimeAdjusted = true;
            }
            else {
                const playheadBufferEnd = range.end;
                var reqForPlayhead = adapter.getFragmentRequestForTime(streamProcessor, representationInfo, playheadBufferEnd, {timeThreshold: 0, keepIdx: false});
                if ( reqForPlayhead && ((reqForPlayhead.startTime + reqForPlayhead.duration - playheadBufferEnd) > 2 / 30) ) {
                    log('[', mediaType, '] Partial fragment - reqNow: ', reqForPlayhead.startTime, ' - ', reqForPlayhead.startTime + reqForPlayhead.duration, '; playheadBufferEnd: ', playheadBufferEnd, '; Repeating playhead fragment');
                    // Partial fragment, re-request fragment
                    time = playheadBufferEnd;
                    hasTimeAdjusted = true;

                    if (!!requestToReplace) {
                        log('[', mediaType, '] Already here for a replace, ignoring time adjust for now');
                    }
                    else {
                        requestToReplace = reqForPlayhead;
                        adapter.setIndexHandlerTime(streamProcessor, requestToReplace.startTime + requestToReplace.duration);
                    }

                }
            }
        }


        let request;
        if (requestToReplace) {
            time = requestToReplace.startTime + (requestToReplace.duration / 2);
            request = adapter.getFragmentRequestForTime(streamProcessor, representationInfo, time, {timeThreshold: 0, ignoreIsFinished: true});
        } else {
            request = adapter.getFragmentRequestForTime(
                streamProcessor, representationInfo, time,
                {
                    timeThreshold: 2 / 30,
                    keepIdx: !hasSeekTarget && !hasTimeAdjusted
                });

            if (request && streamProcessor.getFragmentModel().isFragmentLoaded(request)) {
                log('[', mediaType, '] NextFragmentRequestRule request.index = ', request.index, ' for time = ', time, ' is already loaded!!');
                request = adapter.getNextFragmentRequest(streamProcessor, representationInfo);
            }
            if (request) {
                adapter.setIndexHandlerTime(streamProcessor, request.startTime + request.duration);
                request.delayLoadingTime = new Date().getTime() + scheduleController.getTimeToLoadDelay();
                scheduleController.setTimeToLoadDelay(0);
            }
        }
        if (request) {
            log('[', mediaType, '] NextFragmentRequestRule got request.index = ', request.index, ' request.startTime = ', request.startTime, ' for ', (hasSeekTarget ? 'seekTarget = ' : 'time = '), time);
        }
        return request;
    }

    const instance = {
        execute: execute
    };

    setup();
    return instance;
}

NextFragmentRequestRule.__dashjs_factory_name = 'NextFragmentRequestRule';
export default FactoryMaker.getClassFactory(NextFragmentRequestRule);
