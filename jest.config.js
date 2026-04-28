module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts'],
  testTimeout: 10000,
  moduleNameMapper: {
    '^react-native$': '<rootDir>/__fixtures__/react-native-mock.js',
  },
};
