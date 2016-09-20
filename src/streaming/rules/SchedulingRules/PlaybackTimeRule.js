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
MediaPlayer.rules.PlaybackTimeRule = function () {
    "use strict";

    var seekTarget = {},
        scheduleController = {},
        isSeeking = false,
        VUDU_SEEK_START_TOLERANCE = 0.15, // RIK 20160512 - Moved from magic number.

        onPlaybackSeeking = function(e) {
            // TODO this a dirty workaround to call this handler after a handelr from ScheduleController class. That
            // handler calls FragmentModel.cancelPendingRequests(). We should cancel pending requests before we start
            // creating requests for a seeking time.
            isSeeking = true;
            setTimeout(function() {
                var time = e.data.seekTime;
                //Vudu Eric, do not let seek event time to update audio seek time, it need be adjusted by video seek time
                // RIK: audio and video fragments don't always line-up?
                //seekTarget.audio = time;
                seekTarget.video = time;
                seekTarget.fragmentedText=time;
                isSeeking = false;
            },0);
        };

    return {
        adapter: undefined,
        sourceBufferExt: undefined,
        virtualBuffer: undefined,
        playbackController: undefined,
        textSourceBuffer:undefined,
        log: undefined,

        setup: function() {
            this[MediaPlayer.dependencies.PlaybackController.eventList.ENAME_PLAYBACK_SEEKING] = onPlaybackSeeking;
        },

        setScheduleController: function(scheduleControllerValue) {
            var streamId = scheduleControllerValue.streamProcessor.getStreamInfo().id;
            scheduleController[streamId] = scheduleController[streamId] || {};
            scheduleController[streamId][scheduleControllerValue.streamProcessor.getType()] = scheduleControllerValue;
        },

        execute: function(context, callback) {
            var mediaInfo = context.getMediaInfo(),
                mediaType = mediaInfo.type,
                streamId = context.getStreamInfo().id,
                sc = scheduleController[streamId][mediaType],
                // EPSILON is used to avoid javascript floating point issue, e.g. if request.startTime = 19.2,
                // request.duration = 3.83, than request.startTime + request.startTime = 19.2 + 1.92 = 21.119999999999997
                EPSILON = 0.1,
                streamProcessor = scheduleController[streamId][mediaType].streamProcessor,
                representationInfo = streamProcessor.getCurrentRepresentationInfo(),
                st = seekTarget ? seekTarget[mediaType] : null,
                hasSeekTarget = (st !== undefined) && (st !== null),
                p = hasSeekTarget ? MediaPlayer.rules.SwitchRequest.prototype.STRONG  : MediaPlayer.rules.SwitchRequest.prototype.DEFAULT,
                rejected = sc.getFragmentModel().getRequests({state: MediaPlayer.dependencies.FragmentModel.states.REJECTED})[0],
                keepIdx = !!rejected && !hasSeekTarget,
                currentTime = streamProcessor.getIndexHandlerTime(),
                playbackTime = this.playbackController.getTime(),
                rejectedEnd = rejected ? rejected.startTime + rejected.duration : null,
                useRejected = !hasSeekTarget && rejected && ((rejectedEnd > playbackTime) && (rejected.startTime <= currentTime) || isNaN(currentTime)),
                buffer = streamProcessor.bufferController.getBuffer(),
                appendedChunks,
                range = null,
                time,
                request;
            //Vudu Eric, when the seeking event happened, but still not set the value done yet because of above ugly hack
            //we do not do anything. because all the generated request is not right for this new seek event.
            //wait until the set is done.
            if (isSeeking) {
                callback(new MediaPlayer.rules.SwitchRequest(null, p));
                return;
            }

            if (mediaType === "audio" && seekTarget.video !== undefined && seekTarget.video !== null) {
                //this.log("Audio need wait video finished their seek operation, then go!!");
                callback(new MediaPlayer.rules.SwitchRequest(null, p));
                return;
            }

            time = hasSeekTarget ? st : ((useRejected ? (rejected.startTime) : currentTime));

            // limit proceeding index handler to max buffer -> limit pending requests queue
            if (!hasSeekTarget && !rejected && (!isNaN(time) && (time > playbackTime + MediaPlayer.dependencies.BufferController.BUFFER_TIME_AT_TOP_QUALITY))) {
                callback(new MediaPlayer.rules.SwitchRequest(null, p));
                return;
            }

            if (rejected) {
                sc.getFragmentModel().removeRejectedRequest(rejected);
            }

            if (isNaN(time) || (mediaType === "fragmentedText" && this.textSourceBuffer.getAllTracksAreDisabled())) {
                callback(new MediaPlayer.rules.SwitchRequest(null, p));
                return;
            }

            if (buffer) {
                range = this.sourceBufferExt.getBufferRange(streamProcessor.bufferController.getBuffer(), time);
                if (range !== null) {
                    appendedChunks = this.virtualBuffer.getChunks({streamId: streamId, mediaType: mediaType, appended: true, mediaInfo: mediaInfo, forRange: range});
                    if (appendedChunks && appendedChunks.length > 0) {
                        time = appendedChunks[appendedChunks.length-1].bufferedRange.end;
                    }
                }
            }

            request = this.adapter.getFragmentRequestForTime(streamProcessor, representationInfo, time, {keepIdx: keepIdx});
            //Vudu Eric, if seek time is too close to a segment's start time, we go to grab previous one,
            //because there are maybe some time mismatch between SIDX table and the real mp4 segment's start time.
            //Mistmatch may happen for non-Vudu content, so implement here in generic player, not in VUDU specific module
            if (request && hasSeekTarget) {
                if ( (time > request.startTime) && (time - request.startTime < VUDU_SEEK_START_TOLERANCE) ) {
					var adjustedStartTime = time - VUDU_SEEK_START_TOLERANCE;

					if (adjustedStartTime < 0){
						adjustedStartTime = 0;
					}

                    request = this.adapter.getFragmentRequestForTime(streamProcessor, representationInfo, adjustedStartTime, {keepIdx: keepIdx, timeThreshold: 0});
                }
            }

            if (useRejected && request && request.index !== rejected.index) {
                request = this.adapter.getFragmentRequestForTime(streamProcessor, representationInfo, rejected.startTime + (rejected.duration / 2) + EPSILON, {keepIdx: keepIdx, timeThreshold: 0});
            }

            while (request && streamProcessor.getFragmentModel().isFragmentLoadedOrPendingAndNotDiscarded(request)) {
                request = this.adapter.getNextFragmentRequest(streamProcessor, representationInfo);
            }

            if (request && !useRejected) {
                streamProcessor.setIndexHandlerTime(request.startTime + request.duration);
            }

            if (request && hasSeekTarget) {
                seekTarget[mediaType] = null;
                //Vudu Eric, adjust audio seek time to the seeked video segment start Time.
                //because it looks like playback time will be the seeked video segment start Time
                if(mediaType === "video") {
                  //this.log("adjust audio seek time from " + time + " to the start of the seeked video segment startTime = " + request.startTime);
                  seekTarget.audio = request.startTime;
                }
            }

            callback(new MediaPlayer.rules.SwitchRequest(request, p));
        },

        reset: function() {
            seekTarget = {};
            scheduleController = {};
        }
    };
};

MediaPlayer.rules.PlaybackTimeRule.prototype = {
    constructor: MediaPlayer.rules.PlaybackTimeRule
};
