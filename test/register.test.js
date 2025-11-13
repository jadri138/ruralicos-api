const request = require('supertest');
const app = require('../index');

describe('Registro de usuarios', () => {
  it('registra un nuevo usuario', async () => {
    const res = await request(app)
      .post('/register')
      .send({ phone: '+34666123499' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('no permite duplicados', async () => {
    await request(app).post('/register').send({ phone: '+34666123498' });

    const res = await request(app)
      .post('/register')
      .send({ phone: '+34666123498' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('ya está registrado');
  });
});
