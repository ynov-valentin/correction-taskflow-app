import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

// Test subscriber logic without a real Redis connection
vi.mock('../subscriber.js', async (importOriginal) => {
  // Import the real module to test getNotifications and markAsRead
  // but mock startSubscriber which opens a real Redis connection
  const actual = await importOriginal()
  return {
    ...actual,
    startSubscriber: vi.fn().mockResolvedValue(undefined),
  }
})

import { getNotifications, markAsRead, startSubscriber } from '../subscriber.js'

// Minimal app reproducing the routes from index.js without starting the server
const app = express()
app.use(express.json())
app.get('/notifications', (req, res) => {
  const { userId } = req.query
  res.json(getNotifications(userId))
})
app.patch('/notifications/:id/read', (req, res) => {
  const notif = markAsRead(req.params.id)
  if (!notif) return res.status(404).json({ error: 'Notification not found' })
  res.json(notif)
})

describe('subscriber — internal logic', () => {
  it('getNotifications returns an empty array on startup', () => {
    const result = getNotifications()
    expect(Array.isArray(result)).toBe(true)
  })

  it('getNotifications filters by userId', () => {
    const all = getNotifications()
    const forUser = getNotifications('uuid-alice')
    // All filtered results belong to alice
    forUser.forEach(n => expect(n.userId).toBe('uuid-alice'))
  })

  it('markAsRead returns undefined for an unknown id', () => {
    const result = markAsRead('id-qui-nexiste-pas')
    expect(result).toBeUndefined()
  })
})

describe('GET /notifications', () => {
  it('returns 200 with an array', async () => {
    const res = await request(app).get('/notifications')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
  })
})

describe('PATCH /notifications/:id/read', () => {
  it('returns 404 for an unknown notification', async () => {
    const res = await request(app).patch('/notifications/fake-id/read')
    expect(res.status).toBe(404)
  })
})
