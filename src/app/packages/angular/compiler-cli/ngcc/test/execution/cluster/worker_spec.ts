/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

/// <reference types="node" />

import * as cluster from 'cluster';
import {EventEmitter} from 'events';

import {ClusterWorker} from '../../../src/execution/cluster/worker';
import {Task, TaskCompletedCallback, TaskProcessingOutcome} from '../../../src/execution/tasks/api';
import {MockLogger} from '../../helpers/mock_logger';
import {mockProperty} from '../../helpers/spy_utils';


describe('ClusterWorker', () => {
  const runAsClusterMaster = mockProperty(cluster, 'isMaster');
  const mockProcessSend = mockProperty(process, 'send');
  let processSendSpy: jasmine.Spy;
  let compileFnSpy: jasmine.Spy;
  let createCompileFnSpy: jasmine.Spy;
  let mockLogger: MockLogger;

  beforeEach(() => {
    compileFnSpy = jasmine.createSpy('compileFn');
    createCompileFnSpy = jasmine.createSpy('createCompileFn').and.returnValue(compileFnSpy);

    processSendSpy = jasmine.createSpy('process.send');
    mockProcessSend(processSendSpy);

    mockLogger = new MockLogger();
  });

  describe('constructor()', () => {
    describe('(on cluster master)', () => {
      beforeEach(() => runAsClusterMaster(true));

      it('should throw an error', () => {
        expect(() => new ClusterWorker(mockLogger, createCompileFnSpy))
            .toThrowError('Tried to instantiate `ClusterWorker` on the master process.');
        expect(createCompileFnSpy).not.toHaveBeenCalled();
      });
    });

    describe('(on cluster worker)', () => {
      beforeEach(() => runAsClusterMaster(false));

      it('should create the `compileFn()`', () => {
        new ClusterWorker(mockLogger, createCompileFnSpy);
        expect(createCompileFnSpy).toHaveBeenCalledWith(jasmine.any(Function));
      });

      it('should set up `compileFn()` to send `task-completed` messages to master', () => {
        new ClusterWorker(mockLogger, createCompileFnSpy);
        const onTaskCompleted: TaskCompletedCallback = createCompileFnSpy.calls.argsFor(0)[0];

        onTaskCompleted(null as any, TaskProcessingOutcome.Processed, null);
        expect(processSendSpy).toHaveBeenCalledTimes(1);
        expect(processSendSpy).toHaveBeenCalledWith({
          type: 'task-completed',
          outcome: TaskProcessingOutcome.Processed,
          message: null
        });

        processSendSpy.calls.reset();

        onTaskCompleted(null as any, TaskProcessingOutcome.Failed, 'error message');
        expect(processSendSpy).toHaveBeenCalledTimes(1);
        expect(processSendSpy).toHaveBeenCalledWith({
          type: 'task-completed',
          outcome: TaskProcessingOutcome.Failed,
          message: 'error message',
        });
      });
    });
  });

  describe('run()', () => {
    describe(
        '(on cluster master)',
        () => {/* No tests needed, becasue the constructor would have thrown. */});

    describe('(on cluster worker)', () => {
      // The `cluster.worker` property is normally `undefined` on the master process and set to the
      // current `cluster.Worker` on worker processes.
      const mockClusterWorker = mockProperty(cluster, 'worker');
      let worker: ClusterWorker;

      beforeEach(() => {
        runAsClusterMaster(false);
        mockClusterWorker(Object.assign(new EventEmitter(), {id: 42}) as cluster.Worker);

        worker = new ClusterWorker(mockLogger, createCompileFnSpy);
      });

      it('should return a promise (that is never resolved)', done => {
        const promise = worker.run();

        expect(promise).toEqual(jasmine.any(Promise));

        promise.then(
            () => done.fail('Expected promise not to resolve'),
            () => done.fail('Expected promise not to reject'));

        // We can't wait forever to verify that the promise is not resolved, but at least verify
        // that it is not resolved immediately.
        setTimeout(done, 100);
      });

      it('should handle `process-task` messages', () => {
        const mockTask = {
          entryPoint: {name: 'foo'},
          formatProperty: 'es2015',
          processDts: true,
        } as unknown as Task;

        worker.run();
        cluster.worker.emit('message', {type: 'process-task', task: mockTask});

        expect(compileFnSpy).toHaveBeenCalledWith(mockTask);
        expect(processSendSpy).not.toHaveBeenCalled();

        expect(mockLogger.logs.debug[0]).toEqual([
          '[Worker #42] Processing task: {entryPoint: foo, formatProperty: es2015, processDts: true}',
        ]);
      });

      it('should send errors during task processing back to the master process', () => {
        const mockTask = {
          entryPoint: {name: 'foo'},
          formatProperty: 'es2015',
          processDts: true,
        } as unknown as Task;

        let err: string|Error;
        compileFnSpy.and.callFake(() => { throw err; });

        worker.run();

        err = 'Error string.';
        cluster.worker.emit('message', {type: 'process-task', task: mockTask});
        expect(processSendSpy).toHaveBeenCalledWith({type: 'error', error: err});

        err = new Error('Error object.');
        cluster.worker.emit('message', {type: 'process-task', task: mockTask});
        expect(processSendSpy).toHaveBeenCalledWith({type: 'error', error: err.stack});
      });

      it('should throw, when an unknown message type is received', () => {
        worker.run();
        cluster.worker.emit('message', {type: 'unknown', foo: 'bar'});

        expect(compileFnSpy).not.toHaveBeenCalled();
        expect(processSendSpy).toHaveBeenCalledWith({
          type: 'error',
          error: jasmine.stringMatching(
              'Error: \\[Worker #42\\] Invalid message received: {"type":"unknown","foo":"bar"}'),
        });
      });
    });
  });
});
