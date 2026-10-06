// Every jest test file gets its own module registry, so each one that loads the
// app builds its own Prisma connection pool. Many suites never disconnect, and
// in a full --runInBand run the leaked pools accumulate until Postgres answers
// "too many clients already". Release this file's pool once its tests finish.
afterAll(async () => {
  try {
    await require('../src/config/prisma').$disconnect();
  } catch {
    // Already disconnected, or the module was never loaded by this suite.
  }
});
