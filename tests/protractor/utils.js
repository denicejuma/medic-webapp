const _ = require('underscore'),
      auth = require('./auth')(),
      constants = require('./constants'),
      http = require('http'),
      path = require('path'),
      htmlScreenshotReporter = require('protractor-jasmine2-screenshot-reporter'),
      userSettingsDocId = `org.couchdb.user:${auth.user}`;

const PouchDB = require('pouchdb-core');
PouchDB.plugin(require('pouchdb-adapter-http'));
PouchDB.plugin(require('pouchdb-mapreduce'));
const db = new PouchDB(`http://${auth.user}:${auth.pass}@${constants.COUCH_HOST}:${constants.COUCH_PORT}/${constants.DB_NAME}`);

let originalSettings;

// First Object is passed to http.request, second is for specific options / flags
// for this wrapper
const request = (options, {debug, noAuth, notJson} = {}) => {
  if (typeof options === 'string') {
    options = {
      path: options
    };
  }

  const deferred = protractor.promise.defer();

  options.hostname = constants.API_HOST;
  options.port = constants.API_PORT;
  if (!noAuth) {
    options.auth = options.auth || auth.user + ':' + auth.pass;
  }

  if (debug) {
    console.log('!!!!!!!REQUEST!!!!!!!');
    console.log('!!!!!!!REQUEST!!!!!!!');
    console.log(JSON.stringify(options));
    console.log('!!!!!!!REQUEST!!!!!!!');
    console.log('!!!!!!!REQUEST!!!!!!!');
  }

  const req = http.request(options, res => {
    res.setEncoding('utf8');
    let body = '';
    res.on('data', chunk => {
      body += chunk;
    });
    res.on('end', () => {
      try {
        if (notJson) {
          return deferred.fulfill(body);
        }

        body = JSON.parse(body);
        if (body.error) {
          deferred.reject(new Error(`Request failed: ${options.path},\n  body: ${JSON.stringify(options.body)}\n  response: ${JSON.stringify(body)}`));
        } else {
          deferred.fulfill(body);
        }
      } catch (e) {
        let errorMessage;

        if(body === 'Server error') {
          errorMessage = 'Server returned an error.  Check medic-api logs for details.';
        } else {
          errorMessage = `Server returned an error.  Response body: ${body}`;
        }

        const err = new Error(errorMessage);
        err.responseBody = body;
        deferred.reject(err);
      }
    });
  });
  req.on('error', e => {
    console.log('Request failed: ' + e.message);
    deferred.reject(e);
  });

  if (options.body) {
    if (typeof options.body === 'string') {
      req.write(options.body);
    } else {
      req.write(JSON.stringify(options.body));
    }
  }

  req.end();

  return deferred.promise;
};

// Update both ddocs, to avoid instability in tests.
// Note that API will be copying changes to medic over to medic-client, so change
// medic-client first (api does nothing) and medic after (api copies changes over to
// medic-client, but the changes are already there.)
const updateSettings = updates => {
  if (originalSettings) {
    throw new Error('A previous test did not call revertSettings');
  }
  return request({
    path: '/api/v1/settings',
    method: 'GET'
  }).then(settings => {
    originalSettings = settings;
    // Make sure all updated fields are present in originalSettings, to enable reverting later.
    Object.keys(updates).forEach(updatedField => {
      if (!_.has(originalSettings, updatedField)) {
        originalSettings[updatedField] = null;
      }
    });
    return;
  }).then(() => {
    return request({
      path: '/api/v1/settings?replace=1',
      method: 'PUT',
      body: JSON.stringify(updates),
      headers: { 'Content-Type': 'application/json' }
    });
  });
};

const revertSettings = () => {
  if (!originalSettings) {
    return Promise.resolve(false);
  }
  return request({
    path: '/api/v1/settings?replace=1',
    method: 'PUT',
    body: JSON.stringify(originalSettings),
    headers: { 'Content-Type': 'application/json' }
  }).then(() => {
    originalSettings = null;
    return true;
  });
};

const deleteAll = (except = []) => {
  // Generate a list of functions to filter documents over
  const ignorables = except.concat(
    doc => ['translations', 'translations-backup', 'user-settings', 'info'].includes(doc.type),
    'appcache',
    'migration-log',
    'resources',
    /^_design/
  );
  const ignoreFns = [];
  const ignoreStrings = [];
  const ignoreRegex = [];
  ignorables.forEach(i => {
    if (typeof i === 'function') {
      ignoreFns.push(i);
    } else if (typeof i === 'object') {
      ignoreRegex.push(i);
    } else {
      ignoreStrings.push(i);
    }
  });

  ignoreFns.push(doc => ignoreStrings.includes(doc._id));
  ignoreFns.push(doc => ignoreRegex.find(r => doc._id.match(r)));

  // Get, filter and delete documents
  return module.exports.request({
    path: path.join('/', constants.DB_NAME, '_all_docs?include_docs=true'),
    method: 'GET'
  })
    .then(({rows}) => rows
      .filter(({doc}) => !ignoreFns.find(fn => fn(doc)))
      .map(({doc}) => {
        doc._deleted = true;
        return doc;
      }))
    .then(toDelete => {
      const ids = toDelete.map(doc => doc._id);
      console.log(`Deleting docs: ${ids}`);
      return module.exports.request({
        path: path.join('/', constants.DB_NAME, '_bulk_docs'),
        method: 'POST',
        body: JSON.stringify({ docs: toDelete }),
        headers: { 'content-type': 'application/json' }
      }).then(response => {
        console.log(`Deleted docs: ${JSON.stringify(response)}`);
      });
    });
};

const refreshToGetNewSettings = () => {
  // wait for the updates to replicate
  const dialog = element(by.css('#update-available .submit:not(.disabled)'));
  return browser.wait(protractor.ExpectedConditions.elementToBeClickable(dialog), 10000)
    .then(() => {
      dialog.click();
    })
    .catch(() => {
      // sometimes there's a double update which causes the dialog to be redrawn
      // retry with the new dialog
      dialog.isPresent().then(function(result) {
        if (result) {
          dialog.click();
        }
      });
    })
    .then(() => {
      return browser.wait(protractor.ExpectedConditions.elementToBeClickable(element(by.id('contacts-tab'))), 10000);
    });
};

const revertDb = (except, ignoreRefresh) => {
  return revertSettings().then(needsRefresh => {
    return deleteAll(except).then(() => {
      // only need to refresh if the settings were changed
      if (!ignoreRefresh && needsRefresh) {
        return refreshToGetNewSettings();
      }
    });
  });
};

module.exports = {

  db: db,

  request: request,

  reporter: new htmlScreenshotReporter({
    reportTitle: 'e2e Test Report',
    inlineImages: true,
    showConfiguration: true,
    captureOnlyFailedSpecs: true,
    reportOnlyFailedSpecs: false,
    showQuickLinks: true,
    dest: 'tests/results',
    filename: 'report.html',
    pathBuilder: function(currentSpec) {
      return currentSpec.fullName.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '_');
    }
  }),

  requestOnTestDb: (options, debug) => {
    if (typeof options === 'string') {
      options = {
        path: options
      };
    }
    options.path = '/' + constants.DB_NAME + (options.path || '');
    return request(options, {debug: debug});
  },

  saveDoc: doc => {
    const postData = JSON.stringify(doc);
    return module.exports.requestOnTestDb({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': postData.length
      },
      body: postData
    });
  },

  saveDocs: docs => module.exports.requestOnTestDb({
    path: '/_bulk_docs',
    method: 'POST',
    body: { docs: docs },
    headers: { 'content-type': 'application/json' }
  }).then(results => {
    if (results.find(r => !r.ok)) {
      throw Error(results);
    } else {
      return results;
    }
  }),

  getDoc: id => {
    return module.exports.requestOnTestDb({
      path: `/${id}`,
      method: 'GET'
    });
  },

  getAuditDoc: id => {
    return module.exports.requestOnTestDb({
      path: `-audit/${id}-audit`,
      method: 'GET'
    });
  },

  deleteDoc: id => {
    return module.exports.getDoc(id)
      .then(doc => {
        doc._deleted = true;
        return module.exports.saveDoc(doc);
      });
  },

  /**
   * Deletes all docs in the database, except some core docs (read the code) and
   * any docs that you specify.
   *
   * NB: this is back-end only, it does *not* care about the front-end, and will
   * not detect if it needs to refresh
   *
   * @param      {Array}    except  array of: exact document name; or regex; or
   *                                predicate function that returns true if you
   *                                wish to keep the document
   * @return     {Promise}  completion promise
   */
  deleteAllDocs: deleteAll,

  /**
   * Update settings and refresh if required
   *
   * @param      {Object}   updates  Object containing all updates you wish to
   *                                 make
   * @param      {Boolean}  ignoreRefresh  don't bother refreshing
   * @return     {Promise}  completion promise
   */
  updateSettings: (updates, ignoreRefresh) => updateSettings(updates)
      .then(() => {
        if (!ignoreRefresh) {
          return refreshToGetNewSettings();
        }
      }),

  /**
   * Revert settings and refresh if required
   *
   * @param      {Boolean}  ignoreRefresh  don't bother refreshing
   * @return     {Promise}  completion promise
   */
  revertSettings: ignoreRefresh => revertSettings()
    .then(() => {
      if (!ignoreRefresh) {
        return refreshToGetNewSettings();
      }
    }),


  seedTestData: (done, contactId, documents) => {
    protractor.promise
      .all(documents.map(module.exports.saveDoc))
      .then(() => module.exports.getDoc(userSettingsDocId))
      .then((user) => {
        user.contact_id = contactId;
        return module.exports.saveDoc(user);
      })
      .then(done)
      .catch(done.fail);
  },

  /**
   * Cleans up DB after each test. Works with the given callback
   * and also returns a promise - pick one!
   */
  afterEach: done => {
    return revertDb()
      .then(() => {
        if (done) {
          done();
        }
      })
      .catch(err => {
        if (done) {
          done.fail(err);
        } else {
          throw err;
        }
      });
  },

 /**
   * Reverts the db's settings and documents
   *
   * @param      {Array}  except         documents to ignore, see deleteAllDocs
   * @param      {Boolean}  ignoreRefresh  don't bother refreshing
   * @return     {Promise}  promise
   */
  revertDb: revertDb,

  resetBrowser: () => {
    browser.driver.navigate().refresh().then(() => {
      return browser.wait(() => {
        return element(by.css('#messages-tab')).isPresent();
      }, 10000);
    });
  },

  countOf: count => {
    return c => {
      return c === count;
    };
  },

  getCouchUrl: () =>
    `http://${auth.user}:${auth.pass}@${constants.COUCH_HOST}:${constants.COUCH_PORT}/${constants.DB_NAME}`,

  getBaseUrl: () =>
    `http://${constants.API_HOST}:${constants.API_PORT}/${constants.DB_NAME}/_design/medic/_rewrite/#/`,

  getLoginUrl: () =>
    `http://${constants.API_HOST}:${constants.API_PORT}/${constants.DB_NAME}/login`
};
