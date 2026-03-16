const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 * https://metrobundler.dev/docs/configuration/
 *
 * This app lives inside a workspace/monorepo. Metro must be able to see both
 * the app-local node_modules folder and the workspace-root node_modules folder,
 * or physical-device bundling can fail to resolve runtime helpers such as
 * @babel/runtime/helpers/interopRequireDefault.
 *
 * React Native 0.73+ has stable symlink support, but Metro still needs the
 * containing workspace/root path to be visible via watchFolders/nodeModulesPaths.
 * The explicit config below makes device/CI builds deterministic across hoisted
 * and app-local install layouts.
 *
 * @type {import('metro-config').MetroConfig}
 */
const config = {
  watchFolders: [workspaceRoot],
  resolver: {
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(workspaceRoot, 'node_modules'),
    ],
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
