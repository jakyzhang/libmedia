/*
 * libmedia DemuxPipeline
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

import { Data } from 'common/types/type'
import Pipeline, { TaskOptions } from './Pipeline'
import * as errorType from 'avutil/error'
import IPCPort from 'common/network/IPCPort'
import { REQUEST, RpcMessage } from 'common/network/IPCPort'
import { AVFormatContextInterface, AVIFormatContext, createAVIFormatContext } from 'avformat/AVFormatContext'
import IOReader from 'common/io/IOReader'
import IFormat from 'avformat/formats/IFormat'
import * as demux from 'avformat/demux'
import { AVFormat } from 'avformat/avformat'
import { avFree, avMalloc } from 'avutil/util/mem'
import SafeUint8Array from 'cheap/std/buffer/SafeUint8Array'
import List from 'cheap/std/collection/List'
import { AVPacketFlags, AVPacketPool, AVPacketRef } from 'avutil/struct/avpacket'
import { Mutex } from 'cheap/thread/mutex'
import * as logger from 'common/util/logger'
import AVPacketPoolImpl from 'avutil/implement/AVPacketPoolImpl'
import { IOError } from 'common/io/error'
import { AVMediaType, AVPacketSideDataType } from 'avutil/codec'
import LoopTask from 'common/timer/LoopTask'
import { IOFlags } from 'common/io/flags'
import * as array from 'common/util/array'
import { avRescaleQ } from 'avutil/util/rational'
import { AV_MILLI_TIME_BASE_Q, NOPTS_VALUE, NOPTS_VALUE_BIGINT } from 'avutil/constant'
import * as bigint from 'common/util/bigint'
import { AVStreamInterface } from 'avformat/AVStream'
import { addAVPacketSideData, getAVPacketSideData } from 'avutil/util/avpacket'
import { memcpy, memcpyFromUint8Array } from 'cheap/std/memory'
import analyzeAVFormat from 'avutil/function/analyzeAVFormat'
import { WebAssemblyResource } from 'cheap/webassembly/compiler'
import compileResource from 'avutil/function/compileResource'
import isWorker from 'common/function/isWorker'
import * as cheapConfig from 'cheap/config'
import { serializeAVPacket } from 'avutil/util/serialize'
import isPointer from 'cheap/std/function/isPointer'
import * as is from 'common/util/is'

export const STREAM_INDEX_ALL = -1

export interface DemuxTaskOptions extends TaskOptions {
  format?: AVFormat
  bufferLength?: number
  isLive?: boolean
  ioloaderOptions?: Data
  mainTaskId?: string
  avpacketList: pointer<List<pointer<AVPacketRef>>>
  avpacketListMutex: pointer<Mutex>
  flags?: int32
}

type SelfTask = DemuxTaskOptions & {
  leftIPCPort: IPCPort
  rightIPCPorts: Map<number, IPCPort & { streamIndex?: number }>
  controlIPCPort: IPCPort

  formatContext: AVIFormatContext
  ioReader: IOReader
  buffer: pointer<uint8>

  cacheAVPackets: Map<number, pointer<AVPacketRef>[]>
  cacheRequests: Map<number, RpcMessage>
  streamIndexFlush: Map<number, boolean>

  realFormat: AVFormat

  demuxEnded: boolean
  loop: LoopTask

  gopCounter: int32
  lastKeyFramePts: int64
  lastAudioDts: int64
  lastVideoDts: int64

  avpacketPool: AVPacketPool
}

export default class DemuxPipeline extends Pipeline {

  declare tasks: Map<string, SelfTask>

  constructor() {
    super()
  }

  private createTask(options: DemuxTaskOptions): number {
    let leftIPCPort: IPCPort
    let controlIPCPort: IPCPort

    if (options.mainTaskId) {
      const mainTask = this.tasks.get(options.mainTaskId)
      leftIPCPort = mainTask.leftIPCPort
      controlIPCPort = mainTask.controlIPCPort
    }
    else {
      assert(options.leftPort)
      leftIPCPort = new IPCPort(options.leftPort)
      if (options.controlPort) {
        controlIPCPort = new IPCPort(options.controlPort)
      }
    }

    assert(leftIPCPort)

    const bufferLength = options.bufferLength || 1 * 1024 * 1024

    const buf = avMalloc(bufferLength)

    if (!buf) {
      return errorType.NO_MEMORY
    }

    const buffer = new SafeUint8Array(buf, bufferLength)
    const ioReader = new IOReader(bufferLength, true, buffer)

    if (!options.isLive) {
      ioReader.flags |= IOFlags.SEEKABLE
    }
    if (options.flags) {
      ioReader.flags |= options.flags
    }

    ioReader.onFlush = async (buffer) => {

      assert(buffer.byteOffset >= buf && buffer.byteOffset < buf + bufferLength)

      const params: {
        pointer: pointer<uint8>,
        length: int32
        ioloaderOptions?: Data
      } = {
        pointer: reinterpret_cast<pointer<uint8>>(buffer.byteOffset),
        length: buffer.length
      }
      if (options.ioloaderOptions) {
        params.ioloaderOptions = options.ioloaderOptions
      }
      try {
        const result = await leftIPCPort.request<int32 | Uint8Array>('read', params)
        if (is.number(result)) {
          return result
        }
        assert(result.length <= params.length)
        memcpyFromUint8Array(params.pointer, result.length, result)
        return result.length
      }
      catch (error) {
        return IOError.INVALID_OPERATION
      }
    }

    ioReader.onSeek = async (pos) => {
      try {
        const params: {
          pos: int64,
          ioloaderOptions?: Data
        } = {
          pos
        }
        if (options.ioloaderOptions) {
          params.ioloaderOptions = options.ioloaderOptions
        }
        return leftIPCPort.request<int32>('seek', params)
      }
      catch (error) {
        return IOError.INVALID_OPERATION
      }
    }

    ioReader.onSize = async () => {
      try {
        return leftIPCPort.request<int64>('size')
      }
      catch (error) {
        return static_cast<int64>(IOError.INVALID_OPERATION)
      }
    }

    const formatContext = createAVIFormatContext()
    formatContext.ioReader = ioReader

    formatContext.getDecoderResource = async (mediaType, codecId) => {
      if (!controlIPCPort) {
        return
      }
      const wasm: ArrayBuffer | WebAssemblyResource = await controlIPCPort.request('getDecoderResource', {
        codecId,
        mediaType
      })

      return compileResource(wasm, mediaType === AVMediaType.AVMEDIA_TYPE_VIDEO)
    }

    this.tasks.set(options.taskId, {
      ...options,

      leftIPCPort,
      rightIPCPorts: new Map(),
      controlIPCPort,

      formatContext,
      ioReader,
      buffer: buf,

      cacheAVPackets: new Map(),
      cacheRequests: new Map(),
      streamIndexFlush: new Map(),

      realFormat: AVFormat.UNKNOWN,

      demuxEnded: false,
      loop: null,

      gopCounter: 0,
      lastKeyFramePts: 0n,
      lastAudioDts: 0n,
      lastVideoDts: 0n,

      avpacketPool: new AVPacketPoolImpl(accessof(options.avpacketList), options.avpacketListMutex)
    })

    return 0
  }

  public async openStream(taskId: string, maxProbeDuration: int32 = 3000) {
    const task = this.tasks.get(taskId)
    if (task) {
      let ret = await task.leftIPCPort.request<int32>('open')

      if (ret < 0) {
        logger.error(`open ioloader failed, ret: ${ret}`)
        return ret
      }

      let format: AVFormat
      try {
        format = await analyzeAVFormat(task.ioReader, task.format)
        task.format = format
      }
      catch (error) {
        return errorType.DATA_INVALID
      }

      let iformat: IFormat

      switch (format) {
        case AVFormat.FLV:
          if (defined(ENABLE_DEMUXER_FLV)) {
            iformat = new ((await import('avformat/formats/IFlvFormat')).default)
          }
          else {
            logger.error('flv format not support, maybe you can rebuild avmedia')
            return errorType.FORMAT_NOT_SUPPORT
          }
          break
        case AVFormat.MP4:
          if (defined(ENABLE_DEMUXER_MP4) || defined(ENABLE_PROTOCOL_DASH)) {
            iformat = new ((await import('avformat/formats/IMovFormat')).default)
          }
          else {
            logger.error('mp4 format not support, maybe you can rebuild avmedia')
            return errorType.FORMAT_NOT_SUPPORT
          }
          break
        case AVFormat.MPEGTS:
          if (defined(ENABLE_DEMUXER_MPEGPS) || defined(ENABLE_PROTOCOL_HLS)) {
            iformat = new ((await import('avformat/formats/IMpegtsFormat')).default)
          }
          else {
            logger.error('mpegts format not support, maybe you can rebuild avmedia')
            return errorType.FORMAT_NOT_SUPPORT
          }
          break
        case AVFormat.MPEGPS:
          if (defined(ENABLE_DEMUXER_MPEGPS)) {
            iformat = new ((await import('avformat/formats/IMpegpsFormat')).default)
          }
          else {
            logger.error('mpegps format not support, maybe you can rebuild avmedia')
            return errorType.FORMAT_NOT_SUPPORT
          }
          break
        case AVFormat.IVF:
          if (defined(ENABLE_DEMUXER_IVF)) {
            iformat = new ((await import('avformat/formats/IIvfFormat')).default)
          }
          else {
            logger.error('ivf format not support, maybe you can rebuild avmedia')
            return errorType.FORMAT_NOT_SUPPORT
          }
          break
        case AVFormat.OGG:
          if (defined(ENABLE_DEMUXER_OGGS)) {
            iformat = new ((await import('avformat/formats/IOggFormat')).default)
          }
          else {
            logger.error('oggs format not support, maybe you can rebuild avmedia')
            return errorType.FORMAT_NOT_SUPPORT
          }
          break
        case AVFormat.MP3:
          if (defined(ENABLE_DEMUXER_MP3)) {
            iformat = new ((await import('avformat/formats/IMp3Format')).default)
          }
          else {
            logger.error('mp3 format not support, maybe you can rebuild avmedia')
            return errorType.FORMAT_NOT_SUPPORT
          }
          break
        case AVFormat.MATROSKA:
        case AVFormat.WEBM:
          if (defined(ENABLE_DEMUXER_MATROSKA)) {
            iformat = new (((await import('avformat/formats/IMatroskaFormat')).default))
          }
          else {
            logger.error('matroska format not support, maybe you can rebuild avmedia')
            return errorType.FORMAT_NOT_SUPPORT
          }
          break
        case AVFormat.AAC:
          if (defined(ENABLE_DEMUXER_AAC)) {
            iformat = new (((await import('avformat/formats/IAacFormat')).default))
          }
          else {
            logger.error('aac format not support, maybe you can rebuild avmedia')
            return errorType.FORMAT_NOT_SUPPORT
          }
          break
        case AVFormat.FLAC:
          if (defined(ENABLE_DEMUXER_FLAC)) {
            iformat = new (((await import('avformat/formats/IFlacFormat')).default))
          }
          else {
            logger.error('flac format not support, maybe you can rebuild avmedia')
            return errorType.FORMAT_NOT_SUPPORT
          }
          break
        case AVFormat.WAV:
          if (defined(ENABLE_DEMUXER_WAV)) {
            iformat = new (((await import('avformat/formats/IWavFormat')).default))
          }
          else {
            logger.error('wav format not support, maybe you can rebuild avmedia')
            return errorType.FORMAT_NOT_SUPPORT
          }
          break
        case AVFormat.WEBVTT:
          if (defined(ENABLE_DEMUXER_WEBVTT)) {
            iformat = new (((await import('avformat/formats/IWebVttFormat')).default))
          }
          else {
            logger.error('webvtt format not support, maybe you can rebuild avmedia')
            return errorType.FORMAT_NOT_SUPPORT
          }
          break
        case AVFormat.SUBRIP:
          if (defined(ENABLE_DEMUXER_SUBRIP)) {
            iformat = new (((await import('avformat/formats/ISubRipFormat')).default))
          }
          else {
            logger.error('subrip format not support, maybe you can rebuild avmedia')
            return errorType.FORMAT_NOT_SUPPORT
          }
          break
        case AVFormat.ASS:
          if (defined(ENABLE_DEMUXER_ASS)) {
            iformat = new (((await import('avformat/formats/IAssFormat')).default))
          }
          else {
            logger.error('ass format not support, maybe you can rebuild avmedia')
            return errorType.FORMAT_NOT_SUPPORT
          }
          break
        case AVFormat.TTML:
          if (defined(ENABLE_DEMUXER_TTML)) {
            iformat = new (((await import('avformat/formats/ITtmlFormat')).default))
          }
          else {
            logger.error('ttml format not support, maybe you can rebuild avmedia')
            return errorType.FORMAT_NOT_SUPPORT
          }
          break
        case AVFormat.H264:
          if (defined(ENABLE_DEMUXER_H264)) {
            iformat = new (((await import('avformat/formats/IH264Format')).default))
          }
          else {
            logger.error('h264 format not support, maybe you can rebuild avmedia')
            return errorType.FORMAT_NOT_SUPPORT
          }
          break
        case AVFormat.HEVC:
          if (defined(ENABLE_DEMUXER_HEVC)) {
            iformat = new (((await import('avformat/formats/IHevcFormat')).default))
          }
          else {
            logger.error('hevc format not support, maybe you can rebuild avmedia')
            return errorType.FORMAT_NOT_SUPPORT
          }
          break
        case AVFormat.VVC:
          if (defined(ENABLE_DEMUXER_VVC)) {
            iformat = new (((await import('avformat/formats/IVvcFormat')).default))
          }
          else {
            logger.error('vvc format not support, maybe you can rebuild avmedia')
            return errorType.FORMAT_NOT_SUPPORT
          }
          break
        default:
          logger.error('format not support')
          return errorType.FORMAT_NOT_SUPPORT
      }

      assert(iformat)

      task.realFormat = format
      task.formatContext.iformat = iformat

      return demux.open(task.formatContext, {
        maxAnalyzeDuration: maxProbeDuration,
        fastOpen: task.isLive
      })
    }
    else {
      logger.fatal('task not found')
    }
  }

  public async getFormat(taskId: string) {
    const task = this.tasks.get(taskId)
    if (task) {
      return task.realFormat
    }
    else {
      logger.fatal('task not found')
    }
  }

  public async analyzeStreams(taskId: string): Promise<AVFormatContextInterface> {
    const task = this.tasks.get(taskId)
    if (task) {

      await demux.analyzeStreams(task.formatContext)

      const streams: AVStreamInterface[] = []
      for (let i = 0; i < task.formatContext.streams.length; i++) {
        const stream = task.formatContext.streams[i]
        streams.push({
          index: stream.index,
          id: stream.id,
          codecpar: addressof(stream.codecpar),
          nbFrames: stream.nbFrames,
          metadata: stream.metadata,
          duration: stream.duration,
          startTime: stream.startTime,
          disposition: stream.disposition,
          timeBase: {
            den: stream.timeBase.den,
            num: stream.timeBase.num
          }
        })
      }
      return {
        metadata: task.formatContext.metadata,
        format: task.realFormat,
        chapters: task.formatContext.chapters,
        streams
      }
    }
    else {
      logger.fatal('task not found')
    }
  }

  private replyAVPacket(task: SelfTask, ipcPort: IPCPort, request: RpcMessage, avpacket: pointer<AVPacketRef>) {
    if (isWorker() && !cheapConfig.USE_THREADS && isPointer(avpacket)) {
      const data = serializeAVPacket(avpacket)
      const transfer = [data.data.buffer]
      if (data.sideData.length) {
        data.sideData.forEach((side) => {
          transfer.push(side.data.buffer)
        })
      }
      ipcPort.reply(request, data, null, transfer)
      task.avpacketPool.release(avpacket)
      return
    }
    ipcPort.reply(request, avpacket)
  }

  public async connectStreamTask(taskId: string, streamIndex: number, port: MessagePort) {
    const task = this.tasks.get(taskId)
    if (task) {
      const ipcPort: IPCPort & { streamIndex?: number } = new IPCPort(port)

      task.cacheAVPackets.set(streamIndex, [])

      ipcPort.streamIndex = streamIndex
      ipcPort.on(REQUEST, async (request: RpcMessage) => {
        switch (request.method) {
          case 'pull': {
            const cacheAVPackets = task.cacheAVPackets.get(ipcPort.streamIndex)
            if (cacheAVPackets.length) {
              const avpacket = cacheAVPackets.shift()
              if (task.stats !== nullptr) {
                if (task.formatContext.streams[avpacket.streamIndex].codecpar.codecType === AVMediaType.AVMEDIA_TYPE_AUDIO) {
                  task.stats.audioPacketQueueLength--
                }
                else if (task.formatContext.streams[avpacket.streamIndex].codecpar.codecType === AVMediaType.AVMEDIA_TYPE_VIDEO) {
                  task.stats.videoPacketQueueLength--
                }
              }
              this.replyAVPacket(task, ipcPort, request, avpacket)
            }
            else {
              if (task.demuxEnded) {
                ipcPort.reply(request, IOError.END)
              }
              else {
                task.cacheRequests.set(ipcPort.streamIndex, request)
                if (task.loop && task.loop.isStarted()) {
                  task.loop.resetInterval()
                }
              }
            }
            break
          }
        }
      })
      task.rightIPCPorts.set(streamIndex, ipcPort)

      logger.debug(`connect stream ${streamIndex}, taskId: ${task.taskId}`)
    }
    else {
      logger.fatal('task not found')
    }
  }


  public async changeConnectStream(taskId: string, newStreamIndex: number, oldStreamIndex: number, force: boolean = true) {
    const task = this.tasks.get(taskId)
    if (task) {

      if (newStreamIndex === oldStreamIndex) {
        return
      }

      const cache = task.cacheAVPackets.get(oldStreamIndex)
      const ipcPort = task.rightIPCPorts.get(oldStreamIndex)
      const request = task.cacheRequests.get(oldStreamIndex)

      if (!cache) {
        logger.warn(`oldStreamIndex ${oldStreamIndex} not found`)
      }

      await task.loop.stopBeforeNextTick()

      if (force) {
        array.each(cache, (avpacket) => {
          task.avpacketPool.release(avpacket)
        })
        cache.length = 0
      }
      else {
        task.streamIndexFlush.set(newStreamIndex, true)
      }

      ipcPort.streamIndex = newStreamIndex

      task.cacheAVPackets.set(newStreamIndex, cache)
      task.rightIPCPorts.set(newStreamIndex, ipcPort)

      task.cacheAVPackets.delete(oldStreamIndex)
      task.rightIPCPorts.delete(oldStreamIndex)

      if (request) {
        task.cacheRequests.set(newStreamIndex, request)
        task.cacheRequests.delete(oldStreamIndex)
      }

      if (!force) {
        task.loop.start()
      }

      logger.debug(`changed connect stream, new ${newStreamIndex}, old: ${oldStreamIndex}, force: ${force}, taskId: ${task.taskId}`)
    }
    else {
      logger.fatal('task not found')
    }
  }

  public async startDemux(taskId: string, isLive: boolean, minQueueLength: int32) {
    const task = this.tasks.get(taskId)
    if (task) {
      // mpegts 最小 20
      minQueueLength = Math.max(minQueueLength, task.format === AVFormat.MPEGTS ? 20 : 10)

      if (task.loop) {
        task.loop.destroy()
      }
      task.loop = new LoopTask(async () => {
        if (!isLive) {
          let canDo = false
          task.cacheAVPackets.forEach((list, streamIndex) => {
            const stream = task.formatContext.streams.find((stream) => {
              return stream.index === streamIndex
            })
            if (list.length < minQueueLength
              && (stream.codecpar.codecType !== AVMediaType.AVMEDIA_TYPE_SUBTITLE
                || task.cacheAVPackets.size === 1
              )
            ) {
              canDo = true
            }
          })

          if (!canDo) {
            task.loop.emptyTask()
            return
          }
        }

        const avpacket = task.avpacketPool.alloc()

        let ret = await demux.readAVPacket(task.formatContext, avpacket)

        if (!ret) {

          if (defined(ENABLE_LOG_TRACE)) {
            logger.trace(`got packet, index: ${avpacket.streamIndex}, dts: ${avpacket.dts}, pts: ${avpacket.pts}, pos: ${
              avpacket.pos
            }, duration: ${avpacket.duration}, keyframe: ${(avpacket.flags & AVPacketFlags.AV_PKT_FLAG_KEY) ? 'true' : 'false'}`)
          }

          const streamIndex = avpacket.streamIndex

          assert(streamIndex !== NOPTS_VALUE)

          if (task.stats !== nullptr) {
            if (task.formatContext.streams[streamIndex].codecpar.codecType === AVMediaType.AVMEDIA_TYPE_AUDIO
              && task.cacheAVPackets.has(streamIndex)
            ) {
              task.stats.audioPacketCount++
              task.stats.audioPacketBytes += static_cast<int64>(avpacket.size)
              if (task.stats.audioPacketCount > 1 && avpacket.dts > task.lastAudioDts) {
                const list = task.cacheAVPackets.get(streamIndex)
                if (list && list.length) {
                  task.stats.audioEncodeFramerate = Math.round(avpacket.timeBase.den / avpacket.timeBase.num
                    / (static_cast<int32>(avpacket.dts - list[0].dts) / list.length))
                }
                else {
                  task.stats.audioEncodeFramerate = Math.round(avpacket.timeBase.den / avpacket.timeBase.num
                    / static_cast<int32>(avpacket.dts - task.lastAudioDts))
                }
              }
              task.lastAudioDts = avpacket.dts
            }
            else if (task.formatContext.streams[streamIndex].codecpar.codecType === AVMediaType.AVMEDIA_TYPE_VIDEO
              && task.cacheAVPackets.has(streamIndex)
            ) {
              task.stats.videoPacketCount++
              task.stats.videoPacketBytes += static_cast<int64>(avpacket.size)

              if (avpacket.flags & AVPacketFlags.AV_PKT_FLAG_KEY) {
                task.stats.keyFrameCount++
                if (task.stats.keyFrameCount > 1 && avpacket.pts > task.lastKeyFramePts) {
                  task.stats.gop = task.gopCounter
                  task.gopCounter = 1
                  task.stats.keyFrameInterval = static_cast<int32>(avRescaleQ(
                    avpacket.pts - task.lastKeyFramePts,
                    avpacket.timeBase,
                    AV_MILLI_TIME_BASE_Q
                  ))
                }
                task.lastKeyFramePts = avpacket.pts
              }
              else {
                task.gopCounter++
              }
              if (task.stats.videoPacketCount > 1 && avpacket.dts > task.lastVideoDts) {
                const list = task.cacheAVPackets.get(streamIndex)
                if (list && list.length) {
                  task.stats.videoEncodeFramerate = Math.round(avpacket.timeBase.den / avpacket.timeBase.num
                    / (static_cast<int32>(avpacket.dts - list[0].dts) / list.length))
                }
                else {
                  task.stats.videoEncodeFramerate = Math.round(avpacket.timeBase.den / avpacket.timeBase.num
                    / static_cast<int32>(avpacket.dts - task.lastVideoDts))
                }
              }
              task.lastVideoDts = avpacket.dts
            }
          }

          if (task.streamIndexFlush.get(streamIndex)) {
            const stream = task.formatContext.streams.find((stream) => {
              return stream.index === streamIndex
            })
            const ele = getAVPacketSideData(avpacket, AVPacketSideDataType.AV_PKT_DATA_NEW_EXTRADATA)
            if (!ele && stream && stream.codecpar.extradataSize) {
              const data = avMalloc(stream.codecpar.extradataSize)
              memcpy(data, stream.codecpar.extradata, stream.codecpar.extradataSize)
              addAVPacketSideData(avpacket, AVPacketSideDataType.AV_PKT_DATA_NEW_EXTRADATA, data, stream.codecpar.extradataSize)
            }
            task.streamIndexFlush.set(streamIndex, false)
          }

          if (task.cacheRequests.has(streamIndex)) {
            this.replyAVPacket(task, task.rightIPCPorts.get(streamIndex), task.cacheRequests.get(streamIndex), avpacket)
            task.cacheRequests.delete(streamIndex)
          }
          else {
            if (task.cacheAVPackets.has(streamIndex)) {
              task.cacheAVPackets.get(streamIndex).push(avpacket)
              if (task.stats !== nullptr) {
                if (task.formatContext.streams[streamIndex].codecpar.codecType === AVMediaType.AVMEDIA_TYPE_AUDIO) {
                  task.stats.audioPacketQueueLength++
                }
                else if (task.formatContext.streams[streamIndex].codecpar.codecType === AVMediaType.AVMEDIA_TYPE_VIDEO) {
                  task.stats.videoPacketQueueLength++
                }
              }
              if (task.formatContext.streams[streamIndex].codecpar.codecType === AVMediaType.AVMEDIA_TYPE_SUBTITLE) {
                if (task.cacheAVPackets.get(streamIndex).length > minQueueLength) {
                  task.avpacketPool.release(task.cacheAVPackets.get(streamIndex).shift())
                }
              }
            }
            else {
              if (task.rightIPCPorts.has(STREAM_INDEX_ALL)) {
                if (task.cacheRequests.has(STREAM_INDEX_ALL)) {
                  this.replyAVPacket(task, task.rightIPCPorts.get(STREAM_INDEX_ALL), task.cacheRequests.get(STREAM_INDEX_ALL), avpacket)
                  task.cacheRequests.delete(STREAM_INDEX_ALL)
                }
                else {
                  task.cacheAVPackets.get(STREAM_INDEX_ALL).push(avpacket)
                }
              }
              else {
                task.avpacketPool.release(avpacket)
              }
            }
          }
        }
        else {
          task.avpacketPool.release(avpacket)
          if (ret !== IOError.END) {
            logger.error(`demux error, ret: ${ret}, taskId: ${taskId}`)
          }

          task.demuxEnded = true

          logger.info(`demuxer ended, taskId: ${task.taskId}`)

          for (let streamIndex of task.cacheRequests.keys()) {
            const cacheAVPackets = task.cacheAVPackets.get(streamIndex)
            if (!cacheAVPackets.length) {
              task.rightIPCPorts.get(streamIndex).reply(task.cacheRequests.get(streamIndex), IOError.END)
              task.cacheRequests.delete(streamIndex)
            }
          }
          task.loop.stop()
        }
      }, 0, 0, true, false)

      task.loop.start()

      logger.debug(`start demux loop, taskId: ${task.taskId}`)
    }
    else {
      logger.fatal('task not found')
    }
  }

  public async seek(taskId: string, timestamp: int64, flags: int32, streamIndex: int32 = -1): Promise<int64> {
    const task = this.tasks.get(taskId)
    if (task) {
      if (task.loop) {
        await task.loop.stopBeforeNextTick()
        let ret = await demux.seek(task.formatContext, streamIndex, timestamp, flags)
        if (ret >= 0n) {
          task.cacheAVPackets.forEach((list) => {
            array.each(list, (avpacket) => {
              task.avpacketPool.release(avpacket)
            })
            list.length = 0
          })

          if (task.stats !== nullptr) {
            // 判断当前 task 处理的 stream 来重置
            task.cacheAVPackets.forEach((list, streamIndex) => {
              const stream = task.formatContext.streams.find((stream) => {
                return stream.index === streamIndex
              })
              if (stream.codecpar.codecType === AVMediaType.AVMEDIA_TYPE_AUDIO) {
                task.stats.audioPacketQueueLength = 0
              }
              else if (stream.codecpar.codecType === AVMediaType.AVMEDIA_TYPE_VIDEO) {
                task.stats.videoPacketQueueLength = 0
              }
            })
          }

          const avpacket = task.avpacketPool.alloc() as pointer<AVPacketRef>

          while (true) {
            ret = await demux.readAVPacket(task.formatContext, avpacket)
            if (ret < 0 || task.cacheAVPackets.has(avpacket.streamIndex)) {
              break
            }
          }

          if (ret >= 0) {
            task.demuxEnded = false
            const streamIndex = avpacket.streamIndex
            task.cacheAVPackets.get(streamIndex).push(avpacket)

            if (task.stats !== nullptr) {
              if (task.formatContext.streams[avpacket.streamIndex].codecpar.codecType === AVMediaType.AVMEDIA_TYPE_AUDIO) {
                task.stats.audioPacketQueueLength++
              }
              else if (task.formatContext.streams[avpacket.streamIndex].codecpar.codecType === AVMediaType.AVMEDIA_TYPE_VIDEO) {
                task.stats.videoPacketQueueLength++
              }
            }

            task.loop.start()
            let duration = avpacket.pts
            if (task.formatContext.streams[streamIndex].startTime !== NOPTS_VALUE_BIGINT) {
              duration -= task.formatContext.streams[streamIndex].startTime
            }
            else {
              duration -= task.formatContext.streams[streamIndex].firstDTS
            }
            return avRescaleQ(bigint.max(duration, 0n), avpacket.timeBase, AV_MILLI_TIME_BASE_Q)
          }
          else {

            logger.warn(`got first packet failed after seek, taskId: ${task.taskId}`)

            task.avpacketPool.release(avpacket)
            task.demuxEnded = true
            return timestamp
          }
        }
        return ret
      }
      else {

        logger.info('seek before demux loop start')

        let ret = await demux.seek(task.formatContext, -1, timestamp, flags)
        if (ret < 0) {
          return ret
        }
        return timestamp
      }
    }
  }

  /**
   * 裁剪 avpacket 队列大小
   *
   * @param taskId
   * @param max （毫秒）
   */
  public async croppingAVPacketQueue(taskId: string, max: int64) {
    const task = this.tasks.get(taskId)
    if (task) {
      task.cacheAVPackets.forEach((list, streamIndex) => {

        const codecType = task.formatContext.streams[streamIndex].codecpar.codecType

        const lastDts = list[list.length - 1].dts
        let i = list.length - 2
        for (i = list.length - 2; i >= 0; i--) {
          if ((list[i].flags & AVPacketFlags.AV_PKT_FLAG_KEY) || codecType === AVMediaType.AVMEDIA_TYPE_AUDIO) {
            if (avRescaleQ(lastDts - list[i].dts, list[i].timeBase, AV_MILLI_TIME_BASE_Q) >= max) {
              break
            }
          }
        }
        if (i > 0) {
          list.splice(0, i).forEach((avpacket) => {
            task.avpacketPool.release(avpacket)
          })

          if (task.stats !== nullptr) {
            if (codecType === AVMediaType.AVMEDIA_TYPE_AUDIO) {
              task.stats.audioPacketQueueLength = list.length
            }
            else if (codecType === AVMediaType.AVMEDIA_TYPE_VIDEO) {
              task.stats.videoPacketQueueLength = list.length
            }
          }
        }
      })
    }
  }

  public async registerTask(options: DemuxTaskOptions): Promise<number> {
    if (this.tasks.has(options.taskId)) {
      return errorType.INVALID_OPERATE
    }
    return this.createTask(options)
  }

  public async unregisterTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (task) {
      if (task.loop) {
        await task.loop.stopBeforeNextTick()
        task.loop.destroy()
      }
      task.leftIPCPort.destroy()
      task.rightIPCPorts.forEach((ipcPort) => {
        ipcPort.destroy()
      })
      task.rightIPCPorts.clear()
      task.formatContext.destroy()

      avFree(task.buffer)

      task.cacheAVPackets.forEach((list) => {
        list.forEach((avpacket) => {
          task.avpacketPool.release(avpacket)
        })
      })

      this.tasks.delete(taskId)
    }
  }
}
