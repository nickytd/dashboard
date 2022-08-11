//
// SPDX-FileCopyrightText: 2021 SAP SE or an SAP affiliate company and Gardener contributors
//
// SPDX-License-Identifier: Apache-2.0
//

'use strict'

const pRetry = require('p-retry')
const logger = require('../logger')
const config = require('../config')
const tickets = require('../services/tickets')
const channels = require('../channels')

module.exports = (ticketCache, retryOptions = {}) => {
  if (!config.gitHub) {
    logger.warn('Missing gitHub property in config for tickets feature')
    return
  }
  ticketCache.on('issue', event => {
    const eventName = 'issues'
    const { projectName } = event.object.metadata
    const matchesMetadata = metadata => {
      if (Array.isArray(metadata.projectNames)) {
        return metadata.projectNames.includes(projectName)
      }
      return metadata.projectName === projectName
    }
    channels.tickets.broadcast(event, eventName, {
      filter (session) {
        const { events, metadata } = session.state
        return events.includes(eventName) && matchesMetadata(metadata)
      }
    })
  })
  ticketCache.on('comment', event => {
    const eventName = 'comments'
    const { projectName, name } = event.object.metadata
    const matchesMetadata = metadata => {
      return metadata.projectName === projectName && metadata.name === name
    }
    channels.tickets.broadcast(event, eventName, {
      filter (session) {
        const { events, metadata } = session.state
        return events.includes(eventName) && matchesMetadata(metadata)
      }
    })
  })

  async function loadAllOpenIssues () {
    const options = {
      forever: true,
      retries: undefined, // because of retriesLeft calculation in onFailedAttempt
      maxTimeout: 60e3,
      ...retryOptions,
      onFailedAttempt (err) {
        if ([500, 502, 503, 504, 521, 522, 524].indexOf(err.status) === -1) {
          throw err
        }
        logger.info(`Attempt ${err.attemptNumber} failed. Will retry to fetch tickets`)
      }
    }
    try {
      await pRetry(() => tickets.loadOpenIssues(), options)
      logger.info('successfully fetched tickets')
    } catch (err) {
      logger.error('failed to fetch tickets', err)
    }
  }

  function pollTickets () {
    return setInterval(async () => {
      await loadAllOpenIssues()

      const issueNumbers = ticketCache.getIssueNumbers()
      for (const number of issueNumbers) {
        try {
          await tickets.loadIssueComments({ number })
        } catch (err) {
          logger.error('failed to fetch comments for reopened issue %s: %s', number, err)
        }
      }
    }, pollIntervalSeconds * 1000)
  }

  let pollIntervalSeconds = parseInt(config.gitHub.pollIntervalSeconds)
  if (isNaN(pollIntervalSeconds)) {
    pollIntervalSeconds = undefined
  }

  if (!pollIntervalSeconds) {
    return loadAllOpenIssues()
  } else {
    pollTickets()
  }
}
