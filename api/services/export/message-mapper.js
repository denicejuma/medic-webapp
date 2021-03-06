const _ = require('underscore'),
      moment = require('moment'),
      db = require('../../db-pouch');

const normalizeResponse = doc => {
  return {
    type: 'Automated Reply',
    state: 'sent',
    timestamp: doc.reported_date,
    state_history: [{
      state: 'sent',
      timestamp: doc.reported_date
    }],
    messages: doc.responses
  };
};

const normalizeIncoming = doc => {
  return {
    type: 'Message',
    state: 'received',
    timestamp: doc.reported_date,
    state_history: [{
      state: 'received',
      timestamp: doc.reported_date
    }],
    messages: [{
      sent_by: doc.from,
      message: doc.sms_message.message
    }]
  };
};

const buildHistory = task => {
  const history = {};
  if (task.state_history) {
    task.state_history.forEach(item => {
      history[item.state] = item.timestamp;
    });
  }
  return history;
};

const formatDate = date => {
  if (!date) {
    return '';
  }
  return moment(date).valueOf();
};

const getStateDate = (state, task, history) => {
  let date;
  if (state === 'scheduled' && task.due) {
    date = task.due;
  } else if (history[state]) {
    date = history[state];
  } else if (task.state === state) {
    date = task.timestamp;
  }
  return formatDate(date);
};

/*
  Normalize and combine incoming messages, responses, tasks and
  scheduled_tasks into one array Note, auto responses will likely get
  deprecated soon in favor of sentinel based messages.

  Normalized form:
  {
  type: ['Auto Response', 'Incoming Message', <schedule name>, 'Task Message'],
  state: ['received', 'sent', 'pending', 'muted', 'scheduled', 'cleared'],
  timestamp/due: <date string>,
  messages: [{
      uuid: <uuid>,
      to: <phone>,
      message: <message body>
  }]
  }
*/
const normalizeTasks = doc => {
  let tasks = [];
  if (doc.responses && doc.responses.length > 0) {
    tasks.push(normalizeResponse(doc));
  }
  if (doc.tasks && doc.tasks.length > 0) {
    tasks = tasks.concat(doc.tasks);
  }
  if (doc.scheduled_tasks && doc.scheduled_tasks.length > 0) {
    tasks = tasks.concat(doc.scheduled_tasks);
  }
  if (doc.sms_message && doc.sms_message.message) {
    tasks.push(normalizeIncoming(doc));
  }
  return tasks;
};

module.exports = {
  getDocIds: (options) => {
    return db.medic.query('medic/tasks_messages', options)
      .then(result => result.rows)
      .then(rows => rows.map(row => row.id));
  },
  map: () => {
    return Promise.resolve({
      header: [
        'id',
        'patient_id',
        'reported_date',
        'from',
        'type',
        'state',
        'received',
        'scheduled',
        'pending',
        'sent',
        'cleared',
        'muted',
        'message_id',
        'sent_by',
        'to_phone',
        'content'
      ],
      getRows: record => {
        const tasks = normalizeTasks(record);
        return _.flatten(tasks.map(task => {
          const history = buildHistory(task);
          return task.messages.map(message => [
            record._id,
            record.patient_id,
            formatDate(record.reported_date),
            record.from,
            task.type || 'Task Message',
            task.state,
            getStateDate('received', task, history),
            getStateDate('scheduled', task, history),
            getStateDate('pending', task, history),
            getStateDate('sent', task, history),
            getStateDate('cleared', task, history),
            getStateDate('muted', task, history),
            message.uuid,
            message.sent_by,
            message.to,
            message.message
          ]);
        }), true);
      }
    });
  }
};
