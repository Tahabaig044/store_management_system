module.exports = {
  testEnvironment: 'node',
  globalSetup: '<rootDir>/tests/globalSetup.js',
  setupFilesAfterEnv: ['<rootDir>/tests/setupDisconnect.js'],
};
