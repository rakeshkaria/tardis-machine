import qs from 'querystring'
import { combine, compute, streamNormalized } from 'tardis-dev'
import { HttpRequest, WebSocket } from 'uWebSockets.js'
import { debug } from '../debug'
import { constructDataTypeFilter, getComputables, getNormalizers, StreamNormalizedRequestOptions, wait } from '../helpers'

export async function streamNormalizedWS(ws: WebSocket, req: HttpRequest) {
  let messages: AsyncIterableIterator<any> | undefined

  try {
    const startTimestamp = new Date().getTime()
    const parsedQuery = qs.decode(req.getQuery())
    const optionsString = parsedQuery['options'] as string
    const streamNormalizedOptions = JSON.parse(optionsString) as StreamNormalizedRequestOptions

    debug('WebSocket /ws-stream-normalized started, options: %o', streamNormalizedOptions)

    const options = Array.isArray(streamNormalizedOptions) ? streamNormalizedOptions : [streamNormalizedOptions]

    const messagesIterables = options.map((option) => {
      // let's map from provided options to options and normalizers that needs to be added for dataTypes provided in options
      const messages = streamNormalized(
        {
          ...option,
          withDisconnectMessages: true,
          onError: (error) => {
            debug('WebSocket /ws-stream-normalized %s WS connection error: %o', option.exchange, error)
          }
        },
        ...getNormalizers(option.dataTypes)
      )
      // separately check if any computables are needed for given dataTypes
      const computables = getComputables(option.dataTypes)

      if (computables.length > 0) {
        return compute(messages, ...computables)
      }

      return messages
    })

    const filterByDataType = constructDataTypeFilter(options)
    messages = messagesIterables.length === 1 ? messagesIterables[0] : combine(...messagesIterables)

    for await (const message of messages) {
      if (!filterByDataType(message)) {
        continue
      }

      const success = ws.send(JSON.stringify(message))
      // handle backpressure in case of slow clients
      if (!success) {
        let retries = 0
        while (ws.getBufferedAmount() > 0) {
          await wait(20)
          retries += 1

          if (retries > 2000) {
            ws.end(1008, 'Too much backpressure')
          }
        }
      }
    }

    while (ws.getBufferedAmount() > 0) {
      await wait(100)
    }

    ws.end(1000, 'WS stream-normalized finished')

    const endTimestamp = new Date().getTime()

    debug(
      'WebSocket /ws-stream-normalized finished, options: %o, time: %d seconds',
      streamNormalizedOptions,
      (endTimestamp - startTimestamp) / 1000
    )
  } catch (e) {
    // this will underlying open WS connections
    if (messages !== undefined) {
      messages!.return!()
    }

    if (!ws.closed) {
      ws.end(1011, e.toString())
    }

    debug('WebSocket /ws-stream-normalized  error: %o', e)
    console.error('WebSocket /ws-stream-normalized error:', e)
  }
}
