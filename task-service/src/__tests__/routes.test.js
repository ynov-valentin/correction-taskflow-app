import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../db.js', () => ({
  default: { query: vi.fn() },
}))

vi.mock('../publisher.js', () => ({
  publish: vi.fn().mockResolvedValue(undefined),
}))

import db from '../db.js'
import { publish } from '../publisher.js'
import routes from '../routes.js'

const app = express()
app.use(express.json())
app.use('/tasks', routes)

const MOCK_TASK = {
  id: 'uuid-task-1',
  title: 'Écrire les tests',
  description: 'Tests unitaires avec Vitest',
  status: 'todo',
  priority: 'high',
  assignee_id: 'uuid-alice',
  created_by: 'uuid-alice',
  due_date: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /tasks', () => {
  it('returns the task list', async () => {
    db.query.mockResolvedValueOnce({ rows: [MOCK_TASK] })

    const res = await request(app).get('/tasks')

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].title).toBe('Écrire les tests')
  })

  it('returns an empty array when there are no tasks', async () => {
    db.query.mockResolvedValueOnce({ rows: [] })

    const res = await request(app).get('/tasks')

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(0)
  })
})

describe('GET /tasks/:id', () => {
  it('returns a task by id', async () => {
    db.query.mockResolvedValueOnce({ rows: [MOCK_TASK] })

    const res = await request(app).get(`/tasks/${MOCK_TASK.id}`)

    expect(res.status).toBe(200)
    expect(res.body.id).toBe(MOCK_TASK.id)
  })

  it('returns 404 if not found', async () => {
    db.query.mockResolvedValueOnce({ rows: [] })

    const res = await request(app).get('/tasks/uuid-inexistant')

    expect(res.status).toBe(404)
  })
})

describe('POST /tasks', () => {
  it('creates a task and publishes a Redis event', async () => {
    db.query.mockResolvedValueOnce({ rows: [MOCK_TASK] })

    const res = await request(app)
      .post('/tasks')
      .send({ title: 'Écrire les tests', priority: 'high', created_by: 'uuid-alice' })

    expect(res.status).toBe(201)
    expect(res.body.title).toBe('Écrire les tests')
    // Verify that the Redis event was properly published
    expect(publish).toHaveBeenCalledWith('task.created', expect.objectContaining({
      taskId: MOCK_TASK.id,
    }))
  })

  it('returns 400 if title is missing', async () => {
    const res = await request(app)
      .post('/tasks')
      .send({ priority: 'high' })

    expect(res.status).toBe(400)
    // No DB or Redis call should have been made
    expect(db.query).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })
})

describe('PATCH /tasks/:id', () => {
  it('updates the status and publishes a Redis event', async () => {
    const updatedTask = { ...MOCK_TASK, status: 'in_progress' }
    db.query
      .mockResolvedValueOnce({ rows: [MOCK_TASK] })    // SELECT current
      .mockResolvedValueOnce({ rows: [updatedTask] })  // UPDATE

    const res = await request(app)
      .patch(`/tasks/${MOCK_TASK.id}`)
      .send({ status: 'in_progress' })

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('in_progress')
    expect(publish).toHaveBeenCalledWith('task.status_changed', expect.objectContaining({
      oldStatus: 'todo',
      newStatus: 'in_progress',
    }))
  })

  it('does not publish an event if status does not change', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [MOCK_TASK] })
      .mockResolvedValueOnce({ rows: [{ ...MOCK_TASK, title: 'Nouveau titre' }] })

    const res = await request(app)
      .patch(`/tasks/${MOCK_TASK.id}`)
      .send({ title: 'Nouveau titre' }) // no status change

    expect(res.status).toBe(200)
    expect(publish).not.toHaveBeenCalled()
  })
})

describe('DELETE /tasks/:id', () => {
  it('deletes a task and returns 204', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: MOCK_TASK.id }] })

    const res = await request(app).delete(`/tasks/${MOCK_TASK.id}`)

    expect(res.status).toBe(204)
  })

  it('returns 404 if task does not exist', async () => {
    db.query.mockResolvedValueOnce({ rows: [] })

    const res = await request(app).delete('/tasks/uuid-inexistant')

    expect(res.status).toBe(404)
  })
})
