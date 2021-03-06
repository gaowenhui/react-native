/**
 * Copyright (c) 2016-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */
'use strict';

jest.disableAutomock();

const optimizeModule = require('../optimize-module');
const transformModule = require('../transform-module');
const transformer = require('../../../transformer.js');
const {SourceMapConsumer} = require('source-map');
const {fn} = require('../../test-helpers');

const {objectContaining} = jasmine;

describe('optimizing JS modules', () => {
  const filename = 'arbitrary/file.js';
  const optimizationOptions = {
    dev: false,
    platform: 'android',
    postMinifyProcess: x => x,
  };
  const originalCode =
    `if (Platform.OS !== 'android') {
      require('arbitrary-dev');
    } else {
      __DEV__ ? require('arbitrary-android-dev') : require('arbitrary-android-prod');
    }`;

  let transformResult;
  beforeAll(done => {
    transformModule(originalCode, {filename, transformer}, (error, result) => {
      if (error) {
        throw error;
      }
      transformResult = JSON.stringify({type: 'code', details: result.details});
      done();
    });
  });

  it('copies everything from the transformed file, except for transform results', () => {
    const result = optimizeModule(transformResult, optimizationOptions);
    const expected = JSON.parse(transformResult).details;
    delete expected.transformed;
    expect(result.type).toBe('code');
    expect(result.details).toEqual(objectContaining(expected));
  });

  describe('code optimization', () => {
    let dependencyMapName, injectedVars, optimized, requireName;
    beforeAll(() => {
      const result = optimizeModule(transformResult, optimizationOptions);
      optimized = result.details.transformed.default;
      injectedVars = optimized.code.match(/function\(([^)]*)/)[1].split(',');
      [, requireName,,, dependencyMapName] = injectedVars;
    });

    it('optimizes code', () => {
      expect(optimized.code)
        .toEqual(`__d(function(${injectedVars}){${requireName}(${dependencyMapName}[0])});`);
    });

    it('extracts dependencies', () => {
      expect(optimized.dependencies).toEqual(['arbitrary-android-prod']);
    });

    it('creates source maps', () => {
      const consumer = new SourceMapConsumer(optimized.map);
      const column = optimized.code.lastIndexOf(requireName + '(');
      const loc = findLast(originalCode, 'require');

      expect(consumer.originalPositionFor({line: 1, column}))
        .toEqual(objectContaining(loc));
    });

    it('does not extract dependencies for polyfills', () => {
      const result = optimizeModule(
        transformResult,
        {...optimizationOptions, isPolyfill: true},
      ).details;
      expect(result.transformed.default.dependencies).toEqual([]);
    });
  });

  describe('post-processing', () => {
    let postMinifyProcess, optimize;
    beforeEach(() => {
      postMinifyProcess = fn();
      optimize = () =>
        optimizeModule(transformResult, {...optimizationOptions, postMinifyProcess});
    });

    it('passes the result to the provided postprocessing function', () => {
      postMinifyProcess.stub.callsFake(x => x);
      const result = optimize();
      const {code, map} = result.details.transformed.default;
      expect(postMinifyProcess).toBeCalledWith({code, map});
    });

    it('uses the result of the provided postprocessing function for the result', () => {
      const code = 'var postprocessed = "code";';
      const map = {version: 3, mappings: 'postprocessed'};
      postMinifyProcess.stub.returns({code, map});
      expect(optimize().details.transformed.default)
        .toEqual(objectContaining({code, map}));
    });
  });

  it('passes through non-code data unmodified', () => {
    const data = {type: 'asset', details: {arbitrary: 'data'}};
    expect(optimizeModule(JSON.stringify(data), {dev: true, platform: ''}))
      .toEqual(data);
  });
});

function findLast(code, needle) {
  const lines = code.split(/(?:(?!.)\s)+/);
  let line = lines.length;
  while (line--) {
    const column = lines[line].lastIndexOf(needle);
    if (column !== -1) {
      return {line: line + 1, column};
    }
  }
  return null;
}
