/*
 * libmedia VideoDecodePipeline
 *
 * 版权所有 (C) 2024 赵高兴
 * Copyright (C) 2024 Gaoxing Zhao
 *
 * 此文件是 libmedia 的一部分
 * This file is part of libmedia.
 * 
 * libmedia 是自由软件；您可以根据 GNU Lesser General Public License（GNU LGPL）3.1
 * 或任何其更新的版本条款重新分发或修改它
 * libmedia is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3.1 of the License, or (at your option) any later version.
 * 
 * libmedia 希望能够为您提供帮助，但不提供任何明示或暗示的担保，包括但不限于适销性或特定用途的保证
 * 您应自行承担使用 libmedia 的风险，并且需要遵守 GNU Lesser General Public License 中的条款和条件。
 * libmedia is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 */

import Pipeline, { TaskOptions } from './Pipeline'
import * as errorType from 'avutil/error'
import IPCPort from 'common/network/IPCPort'
import { REQUEST, RpcMessage } from 'common/network/IPCPort'
import List from 'cheap/std/collection/List'
import { AVFrameRef } from 'avutil/struct/avframe'
import { Mutex } from 'cheap/thread/mutex'
import WasmVideoDecoder, { AVDiscard } from 'avcodec/wasmcodec/VideoDecoder'
import WebVideoDecoder from 'avcodec/webcodec/VideoDecoder'
import { WebAssemblyResource } from 'cheap/webassembly/compiler'
import * as logger from 'common/util/logger'
import AVFramePoolImpl from 'avutil/implement/AVFramePoolImpl'
import { IOError } from 'common/io/error'
import { AVPacketFlags, AVPacketPool, AVPacketRef } from 'avutil/struct/avpacket'
import * as is from 'common/util/is'
import * as array from 'common/util/array'
import Sleep from 'common/timer/Sleep'
import AVCodecParameters from 'avutil/struct/avcodecparameters'
import AVPacketPoolImpl from 'avutil/implement/AVPacketPoolImpl'
import isWorker from 'common/function/isWorker'
import { AVCodecID } from 'avutil/codec'
import { avQ2D, avRescaleQ } from 'avutil/util/rational'
import getTimestamp from 'common/function/getTimestamp'
import { AV_MILLI_TIME_BASE_Q } from 'avutil/constant'
import support from 'common/util/support'
import isPointer from 'cheap/std/function/isPointer'
import { Data } from 'common/types/type'
import compileResource from 'avutil/function/compileResource'
import { AVCodecParametersSerialize, AVPacketSerialize, unserializeAVCodecParameters, unserializeAVPacket } from 'avutil/util/serialize'
import { avMallocz } from 'avutil/util/mem'
import { copyCodecParameters, freeCodecParameters } from 'avutil/util/codecparameters'

export interface VideoDecodeTaskOptions extends TaskOptions {
  resource: ArrayBuffer | WebAssemblyResource
  enableHardware: boolean
  avpacketList: pointer<List<pointer<AVPacketRef>>>
  avpacketListMutex: pointer<Mutex>
  avframeList: pointer<List<pointer<AVFrameRef>>>
  avframeListMutex: pointer<Mutex>
  preferWebCodecs?: boolean
}

type SelfTask = Omit<VideoDecodeTaskOptions, 'resource'> & {
  resource: WebAssemblyResource
  leftIPCPort: IPCPort
  rightIPCPort: IPCPort

  softwareDecoder: WasmVideoDecoder | WebVideoDecoder
  softwareDecoderOpened: boolean
  hardwareDecoder?: WebVideoDecoder
  targetDecoder: WasmVideoDecoder | WebVideoDecoder

  frameCaches: (pointer<AVFrameRef> | VideoFrame)[]
  inputEnd: boolean

  openReject?: (ret: number) => void

  needKeyFrame: boolean

  parameters: pointer<AVCodecParameters>

  hardwareRetryCount: number

  lastDecodeTimestamp: number

  firstDecoded: boolean

  decoderReady: Promise<void>

  avframePool: AVFramePoolImpl
  avpacketPool: AVPacketPool

  wasmDecoderOptions?: Data
}

export interface VideoDecodeTaskInfo {
  codecId: AVCodecID
  width: int32
  height: int32
  framerate: float
  hardware: boolean
}

export default class VideoDecodePipeline extends Pipeline {

  declare tasks: Map<string, SelfTask>

  constructor() {
    super()
  }

  private createWebcodecDecoder(task: SelfTask, enableHardwareAcceleration: boolean = true) {
    return new WebVideoDecoder({
      onError: (error) => {
        if (task.hardwareRetryCount > 3 || !task.firstDecoded) {
          if (task.targetDecoder === task.hardwareDecoder) {
            task.targetDecoder = task.softwareDecoder
            task.hardwareDecoder.close()
            task.hardwareDecoder = null
            task.decoderReady = this.openSoftwareDecoder(task)
            logger.warn(`video decode error width hardware(${task.hardwareRetryCount}), taskId: ${task.taskId}, error: ${error}, try to fallback to software decoder`)
          }
        }
        else {
          task.hardwareRetryCount++
          try {
            logger.info(`retry open hardware decoder(${task.hardwareRetryCount}), taskId: ${task.taskId}`)
            task.decoderReady = task.hardwareDecoder.open(task.parameters)
          }
          catch (error) {
            logger.warn(`retry open hardware decoder failed, fallback to software decoder, taskId: ${task.taskId}`)
          }
        }
        task.needKeyFrame = true
        task.leftIPCPort.request('requestKeyframe')
      },
      onReceiveFrame(frame) {
        task.firstDecoded = true
        task.frameCaches.push(frame)
        task.stats.videoFrameDecodeCount++
        if (task.lastDecodeTimestamp) {
          task.stats.videoFrameDecodeIntervalMax = Math.max(
            getTimestamp() - task.lastDecodeTimestamp,
            task.stats.videoFrameDecodeIntervalMax
          )
        }
        task.lastDecodeTimestamp = getTimestamp()
      },
      enableHardwareAcceleration
    })
  }

  private createWasmcodecDecoder(task: SelfTask, resource: WebAssemblyResource) {
    return new WasmVideoDecoder({
      resource: resource,
      onError: (error) => {
        logger.error(`video decode error, taskId: ${task.taskId}, error: ${error}`)
        if (task.openReject) {
          task.openReject(errorType.CODEC_NOT_SUPPORT)
          task.openReject = null
        }
      },
      onReceiveFrame(frame) {
        task.firstDecoded = true
        task.frameCaches.push(reinterpret_cast<pointer<AVFrameRef>>(frame))
        task.stats.videoFrameDecodeCount++
        if (task.lastDecodeTimestamp) {
          task.stats.videoFrameDecodeIntervalMax = Math.max(
            getTimestamp() - task.lastDecodeTimestamp,
            task.stats.videoFrameDecodeIntervalMax
          )
        }
        task.lastDecodeTimestamp = getTimestamp()
      },
      avframePool: task.avframePool
    })
  }

  private async pullAVPacketInternal(task: SelfTask, leftIPCPort: IPCPort) {
    const result = await leftIPCPort.request<pointer<AVPacketRef> | AVPacketSerialize>('pull')
    if (is.number(result)) {
      return result
    }
    else {
      const avpacket = task.avpacketPool.alloc()
      unserializeAVPacket(result, avpacket)
      return avpacket
    }
  }

  private async createTask(options: VideoDecodeTaskOptions): Promise<number> {

    assert(options.leftPort)
    assert(options.rightPort)

    const leftIPCPort = new IPCPort(options.leftPort)
    const rightIPCPort = new IPCPort(options.rightPort)
    const frameCaches: (pointer<AVFrameRef> | VideoFrame)[] = []

    const avframePool = new AVFramePoolImpl(accessof(options.avframeList), options.avframeListMutex)

    const task: SelfTask = {
      ...options,
      resource: await compileResource(options.resource, true),
      leftIPCPort,
      rightIPCPort,
      softwareDecoder: null,
      hardwareDecoder: null,
      frameCaches,
      inputEnd: false,
      targetDecoder: null,
      needKeyFrame: true,
      parameters: nullptr,
      hardwareRetryCount: 0,
      lastDecodeTimestamp: 0,
      firstDecoded: false,
      decoderReady: null,
      softwareDecoderOpened: false,

      avframePool,
      avpacketPool: new AVPacketPoolImpl(accessof(options.avpacketList), options.avpacketListMutex)
    }

    task.softwareDecoder = task.resource
      ? this.createWasmcodecDecoder(task, task.resource)
      : (support.videoDecoder ? this.createWebcodecDecoder(task, false) : null)

    if (!task.softwareDecoder) {
      logger.error('software decoder not support')
      return errorType.INVALID_OPERATE
    }

    if (support.videoDecoder && options.enableHardware) {
      task.hardwareDecoder = this.createWebcodecDecoder(task)
    }

    task.targetDecoder = task.hardwareDecoder || task.softwareDecoder

    this.tasks.set(options.taskId, task)

    rightIPCPort.on(REQUEST, async (request: RpcMessage) => {
      switch (request.method) {
        case 'pull': {
          if (frameCaches.length) {
            const frame = frameCaches.shift()
            rightIPCPort.reply(request, frame, null, (isPointer(frame) || is.number(frame)) ? null : [frame])
            break
          }
          else if (!task.inputEnd) {
            while (true) {
              if (frameCaches.length) {
                const frame = frameCaches.shift()
                rightIPCPort.reply(request, frame, null, (isPointer(frame) || is.number(frame)) ? null : [frame])
                break
              }

              if (task.decoderReady) {
                await task.decoderReady
                task.decoderReady = null
              }

              const avpacket = await this.pullAVPacketInternal(task, leftIPCPort)

              if (avpacket === IOError.END) {
                if (task.targetDecoder === task.hardwareDecoder) {
                  // 硬解的 flush 有时会卡主，这里设置 2 秒超时，若超时只能丢弃还未 flush 出来的帧了
                  let ret = await Promise.race([
                    new Sleep(2),
                    task.targetDecoder.flush()
                  ])
                  if (is.number(ret)) {
                    logger.warn(`video hardware decoder flush failed, ignore it, taskId: ${task.taskId}`)
                  }
                }
                else {
                  await task.targetDecoder.flush()
                }
                task.inputEnd = true
                // 等待 flush 出的帧入队
                if (task.targetDecoder === task.hardwareDecoder) {
                  await new Sleep(0)
                }
                if (frameCaches.length) {
                  const frame = frameCaches.shift()
                  rightIPCPort.reply(request, frame, null, task.targetDecoder === task.hardwareDecoder ? [frame] : null)
                  break
                }
                else {
                  logger.info(`video decoder ended, taskId: ${task.taskId}`)
                  rightIPCPort.reply(request, IOError.END)
                  break
                }
              }
              else if (avpacket > 0) {
                if (task.needKeyFrame) {
                  if (avpacket.flags & AVPacketFlags.AV_PKT_FLAG_KEY) {
                    task.needKeyFrame = false
                  }
                  else {
                    // 需要关键帧但不是，跳过继续请求新的 avpacket
                    if (defined(ENABLE_LOG_TRACE)) {
                      logger.trace(`skip the packet because of not got one keyframe, dts: ${avpacket.dts}(${
                        avRescaleQ(avpacket.dts, avpacket.timeBase, AV_MILLI_TIME_BASE_Q)
                      }ms) taskId: ${task.taskId}`)
                    }
                    task.avpacketPool.release(avpacket)
                    continue
                  }
                }
                let ret = task.targetDecoder.decode(avpacket)
                if (ret < 0) {
                  task.stats.videoDecodeErrorPacketCount++
                  // 硬解或者 webcodecs 软解失败
                  if ((task.targetDecoder instanceof WebVideoDecoder) && task.softwareDecoder) {

                    logger.warn(`video decode error from hardware, taskId: ${task.taskId}, error: ${ret}, try to fallback to software decoder`)

                    if (task.targetDecoder === task.hardwareDecoder) {
                      task.hardwareDecoder.close()
                      task.hardwareDecoder = null
                    }
                    else if (task.resource) {
                      task.softwareDecoder.close()
                      task.softwareDecoder = this.createWasmcodecDecoder(task, task.resource)
                    }
                    else {
                      logger.error(`cannot fallback to wasm video decoder because of resource not found , taskId: ${options.taskId}`)
                      rightIPCPort.reply(request, errorType.CODEC_NOT_SUPPORT)
                      break
                    }

                    try {
                      await this.openSoftwareDecoder(task)
                      task.targetDecoder = task.softwareDecoder
                    }
                    catch (error) {
                      logger.error(`video software decoder open error, taskId: ${options.taskId}`)
                      rightIPCPort.reply(request, errorType.CODEC_NOT_SUPPORT)
                      break
                    }

                    if (avpacket.flags & AVPacketFlags.AV_PKT_FLAG_KEY) {
                      ret = task.targetDecoder.decode(avpacket)
                      if (ret >= 0) {
                        task.avpacketPool.release(avpacket)
                        continue
                      }
                      // webcodecs 软解失败，回退到 wasm 软解
                      if ((task.targetDecoder instanceof WebVideoDecoder) && task.resource) {

                        logger.warn(`video decode error width webcodecs soft decoder, taskId: ${task.taskId}, error: ${ret}, try to fallback to wasm software decoder`)

                        task.softwareDecoder.close()
                        task.softwareDecoder = this.createWasmcodecDecoder(task, task.resource)
                        task.softwareDecoderOpened = false
                        try {
                          await this.openSoftwareDecoder(task)
                          task.targetDecoder = task.softwareDecoder
                        }
                        catch (error) {
                          logger.error(`video wasm software decoder open error, taskId: ${options.taskId}`)
                          rightIPCPort.reply(request, errorType.CODEC_NOT_SUPPORT)
                          break
                        }
                        ret = task.targetDecoder.decode(avpacket)
                        if (ret >= 0) {
                          task.avpacketPool.release(avpacket)
                          continue
                        }
                      }
                    }
                    else {
                      task.avpacketPool.release(avpacket)
                      task.needKeyFrame = true
                      task.leftIPCPort.request('requestKeyframe')
                      continue
                    }
                  }
                  task.avpacketPool.release(avpacket)
                  logger.error(`video decode error, taskId: ${options.taskId}, ret: ${ret}`)
                  rightIPCPort.reply(request, ret)
                  break
                }
                task.avpacketPool.release(avpacket)
                // WebVideoDecoder 队列中的 EncodedVideoChunk 过多会导致内存占用激增，这里控制一下
                while (task.targetDecoder instanceof WebVideoDecoder
                  && task.targetDecoder.getQueueLength() > 20
                ) {
                  await new Sleep(0)
                }
                continue
              }
              else {
                logger.error(`video decode pull avpacket error, taskId: ${options.taskId}, ret: ${avpacket}`)
                rightIPCPort.reply(request, avpacket)
                break
              }
            }
            break
          }
          logger.info(`video decoder ended, taskId: ${task.taskId}`)
          rightIPCPort.reply(request, IOError.END)
          break
        }
      }
    })

    return 0
  }

  private async openSoftwareDecoder(task: SelfTask) {
    if (task.softwareDecoder && !task.softwareDecoderOpened) {
      const parameters = task.parameters
      let threadCount = 1

      if (isWorker()) {
        let pixels = parameters.width * parameters.height
        let framerate = avQ2D(parameters.framerate)
        if (pixels >= 1920 * 1080 && pixels <= 2048 * 1080) {
          if (parameters.codecId === AVCodecID.AV_CODEC_ID_HEVC
            || parameters.codecId === AVCodecID.AV_CODEC_ID_VVC
            || parameters.codecId === AVCodecID.AV_CODEC_ID_AV1
          ) {
            threadCount = 2
          }
          if (framerate > 30) {
            threadCount = 2
            if (parameters.codecId === AVCodecID.AV_CODEC_ID_HEVC
              || parameters.codecId === AVCodecID.AV_CODEC_ID_VVC
              || parameters.codecId === AVCodecID.AV_CODEC_ID_AV1
            ) {
              threadCount = 4
            }
          }
          else if (framerate > 60) {
            threadCount = 4
            if (parameters.codecId === AVCodecID.AV_CODEC_ID_HEVC
              || parameters.codecId === AVCodecID.AV_CODEC_ID_VVC
              || parameters.codecId === AVCodecID.AV_CODEC_ID_AV1
            ) {
              threadCount = 6
            }
          }
        }
        else if (pixels > 2048 * 1080 && pixels <= 3840 * 2160) {
          threadCount = 4
          if (parameters.codecId === AVCodecID.AV_CODEC_ID_HEVC
            || parameters.codecId === AVCodecID.AV_CODEC_ID_VVC
            || parameters.codecId === AVCodecID.AV_CODEC_ID_AV1
          ) {
            threadCount = 6
          }
        }
        else if (pixels > 3840 * 2160) {
          threadCount = 6
          if (parameters.codecId === AVCodecID.AV_CODEC_ID_HEVC
            || parameters.codecId === AVCodecID.AV_CODEC_ID_VVC
            || parameters.codecId === AVCodecID.AV_CODEC_ID_AV1
          ) {
            threadCount = 8
          }
        }
        threadCount = Math.min(threadCount, navigator.hardwareConcurrency)
      }

      try {
        await task.softwareDecoder.open(parameters, threadCount, task.wasmDecoderOptions)
      }
      catch (error) {
        if ((task.softwareDecoder instanceof WebVideoDecoder) && task.resource) {

          logger.warn(`webcodecs software decoder open failed, ${error}, try to fallback to wasm software decoder`)

          task.softwareDecoder.close()
          task.softwareDecoder = this.createWasmcodecDecoder(task, task.resource)
          await task.softwareDecoder.open(parameters, threadCount)
          task.targetDecoder = task.softwareDecoder
        }
        else {
          throw error
        }
      }

      task.softwareDecoderOpened = true
    }
  }

  public async reopenDecoder(
    taskId: string,
    parameters: AVCodecParametersSerialize | pointer<AVCodecParameters>,
    resource?: string | ArrayBuffer | WebAssemblyResource,
    wasmDecoderOptions?: Data
  ) {
    const task = this.tasks.get(taskId)
    if (task) {
      const codecpar: pointer<AVCodecParameters> = avMallocz(sizeof(AVCodecParameters))
      if (isPointer(parameters)) {
        copyCodecParameters(codecpar, parameters)
      }
      else {
        unserializeAVCodecParameters(parameters, codecpar)
      }
      if (task.parameters) {
        freeCodecParameters(task.parameters)
      }
      task.parameters = codecpar

      if (wasmDecoderOptions) {
        task.wasmDecoderOptions = wasmDecoderOptions
      }

      if (resource) {
        resource = await compileResource(resource, true)
      }

      let softwareDecoder: WasmVideoDecoder | WebVideoDecoder

      if (task.preferWebCodecs && support.videoDecoder && WebVideoDecoder.isSupported(codecpar, false)) {
        softwareDecoder = this.createWebcodecDecoder(task, false)
      }
      else {
        softwareDecoder = resource
          ? this.createWasmcodecDecoder(task, resource as WebAssemblyResource)
          : (support.videoDecoder ? this.createWebcodecDecoder(task, false) : null)
      }

      let hardwareDecoder: WebVideoDecoder = (support.videoDecoder && task.enableHardware)
        ? this.createWebcodecDecoder(task, true)
        : null
      return new Promise<number>(async (resolve, reject) => {
        task.openReject = resolve
        if (task.softwareDecoder) {
          task.softwareDecoder.close()
        }
        if (task.hardwareDecoder) {
          task.hardwareDecoder.close()
        }
        task.softwareDecoder = softwareDecoder
        task.hardwareDecoder = hardwareDecoder
        task.targetDecoder = task.hardwareDecoder || task.softwareDecoder
        task.hardwareRetryCount = 0

        if (task.hardwareDecoder) {
          try {
            await task.hardwareDecoder.open(codecpar)

            logger.debug(`reopen video hardware decoder, taskId: ${task.taskId}`)
          }
          catch (error) {
            logger.error(`cannot reopen hardware decoder, ${error}, taskId: ${task.taskId}`)
            task.hardwareDecoder.close()
            task.hardwareDecoder = null
            task.targetDecoder = task.softwareDecoder
          }
        }

        if (resource) {
          task.resource = resource as WebAssemblyResource
        }

        if (task.targetDecoder === task.softwareDecoder) {
          try {
            await this.openSoftwareDecoder(task)

            logger.debug(`reopen video soft decoder, taskId: ${task.taskId}`)
          }
          catch (error) {
            logger.error(`reopen video software decoder failed, error: ${error}`)
            if (!task.hardwareDecoder) {
              resolve(errorType.CODEC_NOT_SUPPORT)
              return
            }
          }
        }
        resolve(0)
      })
    }
    logger.fatal('task not found')
  }

  public async open(taskId: string, parameters: AVCodecParametersSerialize | pointer<AVCodecParameters>,  wasmDecoderOptions: Data = {}) {
    const task = this.tasks.get(taskId)
    if (task) {
      task.wasmDecoderOptions = wasmDecoderOptions

      const codecpar: pointer<AVCodecParameters> = avMallocz(sizeof(AVCodecParameters))
      if (isPointer(parameters)) {
        copyCodecParameters(codecpar, parameters)
      }
      else {
        unserializeAVCodecParameters(parameters, codecpar)
      }
      if (task.parameters) {
        freeCodecParameters(task.parameters)
      }
      task.parameters = codecpar

      if (task.preferWebCodecs
        && support.videoDecoder
        && WebVideoDecoder.isSupported(codecpar, false)
        && task.softwareDecoder instanceof WasmVideoDecoder
      ) {
        task.softwareDecoder.close()
        const softwareDecoder = this.createWebcodecDecoder(task, false)
        if (task.softwareDecoder === task.targetDecoder) {
          task.targetDecoder = softwareDecoder
        }
        task.softwareDecoder = softwareDecoder
      }

      return new Promise<number>(async (resolve, reject) => {
        task.openReject = resolve
        if (task.hardwareDecoder) {
          try {
            await task.hardwareDecoder.open(codecpar)
          }
          catch (error) {
            logger.error(`cannot open hardware decoder, ${error}`)
            task.hardwareDecoder.close()
            task.hardwareDecoder = null
            task.targetDecoder = task.softwareDecoder
          }
        }

        if (task.targetDecoder === task.softwareDecoder) {
          try {
            await this.openSoftwareDecoder(task)
          }
          catch (error) {
            logger.error(`open video software decoder failed, error: ${error}`)
            if (!task.hardwareDecoder) {
              resolve(errorType.CODEC_NOT_SUPPORT)
              return
            }
          }
        }
        resolve(0)
      })
    }
    logger.fatal('task not found')
  }

  public async setPlayRate(taskId: string, rate: double) {
    const task = this.tasks.get(taskId)
    if (task && task.softwareDecoder) {
      let discard = AVDiscard.AVDISCARD_NONE
      let framerate = avQ2D(task.parameters.framerate)
      if (framerate >= 120) {
        if (rate <= 1) {
          discard = AVDiscard.AVDISCARD_NONE
        }
        else if (rate < 1.5) {
          discard = AVDiscard.AVDISCARD_NONREF
        }
        else if (rate < 3) {
          // 跳过所有帧间编码帧
          discard = AVDiscard.AVDISCARD_NONREF
        }
        else {
          // 跳过所有帧间编码帧
          discard = AVDiscard.AVDISCARD_NONKEY
        }
      }
      else if (framerate >= 60) {
        if (rate < 1.5) {
          discard = AVDiscard.AVDISCARD_NONE
        }
        else if (rate < 3) {
          discard = AVDiscard.AVDISCARD_NONREF
        }
        else if (rate < 8) {
          discard = AVDiscard.AVDISCARD_NONINTRA
        }
        else {
          discard = AVDiscard.AVDISCARD_NONKEY
        }
      }
      else {
        discard = AVDiscard.AVDISCARD_NONE
      }
      task.softwareDecoder.setSkipFrameDiscard(discard)
    }
  }

  public async resetTask(taskId: string) {
    const task = this.tasks.get(taskId)
    if (task) {
      if (task.targetDecoder === task.softwareDecoder) {
        await task.targetDecoder.flush()
      }
      // webcodec flush 有可能会卡主，这里重新创建解码器
      else if (task.targetDecoder === task.hardwareDecoder) {
        task.hardwareDecoder.close()
        task.hardwareDecoder = this.createWebcodecDecoder(task)
        await task.hardwareDecoder.open(task.parameters)
        task.targetDecoder = task.hardwareDecoder
      }
      array.each(task.frameCaches, (frame) => {
        if (isPointer(frame)) {
          task.avframePool.release(frame)
        }
        else {
          frame.close()
        }
      })
      task.frameCaches.length = 0
      task.needKeyFrame = true
      task.inputEnd = false
      task.lastDecodeTimestamp = getTimestamp()

      logger.info(`reset video decoder, taskId: ${task.taskId}`)
    }
  }

  public async registerTask(options: VideoDecodeTaskOptions): Promise<number> {
    if (this.tasks.has(options.taskId)) {
      return errorType.INVALID_OPERATE
    }
    return this.createTask(options)
  }

  public async unregisterTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (task) {
      task.rightPort.close()
      task.leftPort.close()
      if (task.softwareDecoder) {
        task.softwareDecoder.close()
      }
      if (task.hardwareDecoder) {
        task.hardwareDecoder.close()
      }
      task.frameCaches.forEach((frame) => {
        if (isPointer(frame)) {
          task.avframePool.release(frame)
        }
        else {
          frame.close()
        }
      })
      if (task.parameters) {
        freeCodecParameters(task.parameters)
      }
      this.tasks.delete(taskId)
    }
  }

  public async getTasksInfo() {
    const info: VideoDecodeTaskInfo[] = []
    this.tasks.forEach((task) => {
      info.push({
        codecId: task.parameters.codecId,
        width: task.parameters.width,
        height: task.parameters.height,
        framerate: avQ2D(task.parameters.framerate),
        hardware: task.targetDecoder === task.hardwareDecoder
      })
    })
    return info
  }
}
