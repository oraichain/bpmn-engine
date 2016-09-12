'use strict';

const Code = require('code');
const EventEmitter = require('events').EventEmitter;
const factory = require('../helpers/factory');
const Lab = require('lab');
const testHelper = require('../helpers/testHelpers');

const lab = exports.lab = Lab.script();
const expect = Code.expect;
const Bpmn = require('../..');

lab.experiment('Process', () => {

  lab.experiment('empty', () => {

    lab.test('emits end', (done) => {
      const processXml = `
  <?xml version="1.0" encoding="UTF-8"?>
  <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <process id="theEmptyProcess" isExecutable="true" />
  </definitions>`;

      const engine = new Bpmn.Engine(processXml);
      engine.startInstance(null, null, (err, execution) => {
        if (err) return done(err);
        execution.once('end', () => {
          expect(execution.isEnded).to.be.true();
          done();
        });
      });
    });
  });

  lab.experiment('without sequenceFlows', () => {

    lab.test('starts all without inbound', (done) => {
      const processXml = `
  <?xml version="1.0" encoding="UTF-8"?>
  <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <process id="theUncontrolledProcess" isExecutable="true">
      <userTask id="task1" />
      <scriptTask id="task2" scriptFormat="Javascript">
        <script>
          <![CDATA[
            this.context.input = 2;
            next();
          ]]>
        </script>
      </scriptTask>
    </process>
  </definitions>`;

      const engine = new Bpmn.Engine(processXml);
      engine.startInstance(null, null, (err, execution) => {
        if (err) return done(err);

        const userTask = execution.getChildActivityById('task1');
        userTask.once('start', () => {
          setTimeout(userTask.signal.bind(userTask, ('von Rosen')), 50);
        });

        execution.on('end', () => {
          expect(execution.getChildActivityById('task2').taken, 'task2 taken').to.be.true();
          expect(execution.getChildActivityById('task1').taken, 'task1 taken').to.be.true();

          expect(execution.variables.input).to.equal(2);
          expect(execution.variables.taskInput.task1).to.equal('von Rosen');

          done();
        });
      });
    });

    lab.test('starts task without inbound and then ends with without outbound', (done) => {
      const processXml = `
  <?xml version="1.0" encoding="UTF-8"?>
  <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <process id="theUncontrolledProcess" isExecutable="true">
      <userTask id="task1" />
      <scriptTask id="task2" scriptFormat="Javascript">
        <script>
          <![CDATA[
            const self = this;
            function setContextVariable(callback) {
              if (!self.context.taskInput) {
                return callback(new Error('Missing task input'));
              }

              self.context.userWrote = self.context.taskInput.task1;
              callback();
            }
            setContextVariable(next);
          ]]>
        </script>
      </scriptTask>
      <sequenceFlow id="flow1" sourceRef="task1" targetRef="task2" />
    </process>
  </definitions>`;

      const engine = new Bpmn.Engine(processXml);
      engine.startInstance(null, null, (err, execution) => {
        if (err) return done(err);

        execution.once('end', () => {
          expect(execution.getChildActivityById('task1').taken).to.be.true();
          expect(execution.getChildActivityById('task2').taken).to.be.true();

          expect(execution.variables.taskInput.task1).to.equal('von Rosen');
          expect(execution.variables.userWrote).to.equal('von Rosen');

          done();
        });

        const userTask = execution.getChildActivityById('task1');
        userTask.once('start', () => userTask.signal('von Rosen'));
      });
    });
  });

  lab.experiment('loop', () => {
    lab.test('completes process', (done) => {
      const processXml = factory.resource('loop.bpmn');

      const listener = new EventEmitter();
      let startCount = 0;
      let endCount = 0;
      let cancelCount = 0;
      listener.on('start-scriptTask1', () => {
        startCount++;
      });
      listener.on('end-theEnd', () => {
        endCount++;
      });
      listener.on('cancel-scriptTask2', () => {
        cancelCount++;
        if (cancelCount > 1) {
          done(new Error('Infinite loop'));
        }
      });

      const engine = new Bpmn.Engine(processXml);
      engine.startInstance({
        input: 0
      }, listener, (err, execution) => {
        if (err) return done(err);
        execution.once('end', () => {
          expect(startCount, 'scriptTask1 starts').to.equal(3);
          expect(endCount, 'theEnd count').to.equal(1);
          expect(execution.variables.input).to.equal(2);

          testHelper.expectNoLingeringListeners(execution);
          done();
        });
      });
    });
  });

  lab.experiment('sub process', () => {
    const processXml = factory.resource('sub-process.bpmn');
    lab.test('parent process should only initialise its own', (done) => {
      const engine = new Bpmn.Engine(processXml);
      engine.getInstance(null, null, (err, instance) => {
        if (err) return done(err);
        expect(instance.sequenceFlows.length).to.equal(2);
        done();
      });
    });

    lab.test('completes process', (done) => {
      const listener = new EventEmitter();
      listener.on('start-subUserTask', (task) => {
        task.signal();
      });

      const engine = new Bpmn.Engine(processXml);
      engine.startInstance({
        input: 0
      }, listener, (err, execution) => {
        if (err) return done(err);
        execution.once('end', () => {
          testHelper.expectNoLingeringListeners(execution);
          testHelper.expectNoLingeringListeners(execution.getChildActivityById('subProcess'));
          done();
        });
      });
    });
  });

  lab.experiment('multiple end events', () => {
    const processXml = factory.resource('multiple-endEvents.bpmn');
    lab.test('completes all flows', (done) => {
      const engine = new Bpmn.Engine(processXml);
      engine.startInstance({
        input: 0
      }, null, (err, execution) => {
        if (err) return done(err);
        execution.once('end', () => {
          expect(execution.variables.input, 'iterated input').to.equal(2);
          done();
        });
      });
    });
  });

  lab.experiment('timer event', () => {
    const processXml = factory.resource('timer.bpmn');

    lab.test('timer boundary event cancel task', (done) => {
      const engine = new Bpmn.Engine(processXml);
      engine.startInstance({
        input: 0
      }, null, (err, execution) => {
        if (err) return done(err);

        execution.once('end', () => {
          expect(execution.getChildActivityById('userTask').canceled).to.be.true();
          done();
        });
      });
    });
  });
});