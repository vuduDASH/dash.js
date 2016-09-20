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
MediaPlayer.rules.InsufficientBufferRule = function () {
    "use strict";
    /*
     * This rule is intended to be sure that our buffer doesn't run dry.
     * If the buffer runs dry playback halts until more data is downloaded.
     * The buffer will run dry when the fragments are taking too long to download.
     * The player may have sufficient bandwidth to download a fragment is a reasonable time,
     * but the play may not leave enough time in the buffer to allow for longer fragments.
     * A dry buffer is a good indication of this use case, so we want to switch down to
     * smaller fragments to decrease download time.
     */
    var bufferStateDict = {},
        isStreamCompleted = false,
        lastSwitchTime = 0,
        waitToSwitchTime = 4000,
        setBufferInfo = function (type, state, level) {
            bufferStateDict[type] = bufferStateDict[type] || {};
            bufferStateDict[type].state = state;
            if (state === MediaPlayer.dependencies.BufferController.BUFFER_LOADED && !bufferStateDict[type].firstBufferLoadedEvent) {
                bufferStateDict[type].firstBufferLoadedEvent = true;
            }
            if (level >= (MediaPlayer.dependencies.BufferController.LOW_BUFFER_THRESHOLD_MS*2) && !bufferStateDict[type].initialLowBufferThresholdReached) {
                bufferStateDict[type].initialLowBufferThresholdReached = true;
            }
        },

        onPlaybackSeeking = function () {
            bufferStateDict = {};
            lastSwitchTime = 0;
        },
        
        onStreamCompleted = function () {
            isStreamCompleted = true;
        };

    return {
        log: undefined,
        metricsModel: undefined,
        playbackController: undefined,

        setup: function() {
            this[MediaPlayer.dependencies.PlaybackController.eventList.ENAME_PLAYBACK_SEEKING] = onPlaybackSeeking;
            this[MediaPlayer.dependencies.FragmentController.eventList.ENAME_STREAM_COMPLETED] = onStreamCompleted;
        },

        execute: function (context, callback) {
            var self = this,
                now = new Date().getTime(),
                mediaType = context.getMediaInfo().type,
                current = context.getCurrentValue(),
                metrics = self.metricsModel.getReadOnlyMetricsFor(mediaType),
                lastBufferStateVO = (metrics.BufferState.length > 0) ? metrics.BufferState[metrics.BufferState.length - 1] : null,
                lastBufferLevelVO = (metrics.BufferLevel.length > 0) ? metrics.BufferLevel[metrics.BufferLevel.length - 1] : null,
                switchRequest = new MediaPlayer.rules.SwitchRequest(MediaPlayer.rules.SwitchRequest.prototype.NO_CHANGE, MediaPlayer.rules.SwitchRequest.prototype.WEAK);

            if (now - lastSwitchTime < waitToSwitchTime ||
                lastBufferStateVO === null || lastBufferLevelVO === null) {
                callback(switchRequest);
                return;
            }
            //Vudu Eric once the stream is completed, turn off this rule
            //it will reach the buffer low level and empty status at the end of movie anyway
            if (isStreamCompleted === true) {
                callback(switchRequest);
                return;
            }
            
            setBufferInfo(mediaType, lastBufferStateVO.state, lastBufferLevelVO.level);

            // After the sessions first buffer loaded event , if we ever have a buffer empty event we want to switch all the way down.
            if (lastBufferStateVO.state === MediaPlayer.dependencies.BufferController.BUFFER_EMPTY && bufferStateDict[mediaType].firstBufferLoadedEvent !== undefined) {
                //self.log("InsufficientBufferRule BUFFER_EMPTY happened, current quality = " + current);
                switchRequest = new MediaPlayer.rules.SwitchRequest(0, MediaPlayer.rules.SwitchRequest.prototype.STRONG);
                bufferStateDict = {};
            } else if (lastBufferStateVO.state === MediaPlayer.dependencies.BufferController.BUFFER_LOADED && bufferStateDict[mediaType].initialLowBufferThresholdReached !== undefined) {
              if (lastBufferLevelVO.level < MediaPlayer.dependencies.BufferController.LOW_BUFFER_THRESHOLD_MS) {
                  //Vudu Eric if buffer level less than LOW_BUFFER_THRESHOLD_MS, we also want to switch all the way down
                  //self.log("InsufficientBufferRule very low buffer level happened level = " + lastBufferLevelVO.level + " current quality = " + current);
                  switchRequest = new MediaPlayer.rules.SwitchRequest(0, MediaPlayer.rules.SwitchRequest.prototype.STRONG);
                  bufferStateDict = {};
              }
            }

            if (switchRequest.value !== MediaPlayer.rules.SwitchRequest.prototype.NO_CHANGE && switchRequest.value !== current) {
                self.log("InsufficientBufferRule requesting switch to index: ", switchRequest.value, "type: ",mediaType, " Priority: ", switchRequest.formatPriority());
                lastSwitchTime = now;
            }

            callback(switchRequest);
        },

        reset: function() {
            bufferStateDict = {};
            lastSwitchTime = 0;
        }
    };
};

MediaPlayer.rules.InsufficientBufferRule.prototype = {
    constructor: MediaPlayer.rules.InsufficientBufferRule
};