'use strict';
var _ = require('lodash'),
    Promise = require('bluebird'),
    util = require('util'),
    express = require('express');

function SkipResponse () {}
function Response (statusCode, mimeType, body) {
  if (_.isNumber(statusCode)) {
    this.statusCode = statusCode;

    if (_.isUndefined(body)) {
      this.body = mimeType;
    } else {
      this.mimeType = mimeType;
      this.body = body;
    }
  } else {
    this.statusCode = 200;
    this.mimeType = statusCode;
    this.body = mimeType;
  }
}

module.exports = function (options) {
  options = _.defaults(options || {}, {
    defaultAuthentication: null,
    defaultAuthorization: null,
    passport: null,
    sequelize: null,
    traceLogger: console.log,
    errorLogger: console.error,
    roleChecker: function () {
      return false;
    }
  });

  var validationError,
      routeCache = {},
      apiRouter = express.Router(),
      priorityRouter = express.Router();

  // If null, blackhole it.
  if (_.isNull(options.traceLogger)) {
    options.traceLogger = function () {};
  }

  // If null, blackhole it.
  if (_.isNull(options.errorLogger)) {
    options.errorLogger = function () {};
  }

  if (options.sequelize) {
    validationError = options.sequelize.ValidationError;
  } else {
    validationError = function () {
      return false;
    };
  }

  function authenticate(req, res, authMethod) {
    return new Promise(function (resolve, reject) {
      if (_.isNull(authMethod)) { // Null is no authentication at all.
        resolve();
      } else if (_.isFunction(authMethod)) {
        Promise.method(authMethod)(req)
        .then(function (result) {
          if (_.isUndefined(result) || (_.isBoolean(result) && result)) {
            resolve();
          } else {
            reject();
          }
        })
        .catch(reject);
      } else { // Use passport authentication.
        if (!_.isNull(options.passport)) {
          options.passport.authenticate(authMethod, { session: false })(req, res, function (err) {
            if (err) {
              reject();
            } else {
              resolve();
            }
          });
        } else {
          reject();
        }
      }
    })
    .catch(function () {
      return Promise.reject(401);
    });
  }

  function authorize (req, authMethod) {
    if (!_.isArray(authMethod)) {
      authMethod = [authMethod];
    }

    return Promise.map(authMethod, function (method) {
      if (_.isNull(method)) { // Null means no authorization method was picked. So skip it.
        return Promise.resolve();
      } else if (_.isString(method)) { // String is a role. So we'll need to use the external role checker.
        return Promise.method(options.roleChecker)(req.user, method)
        .then(function () {
          return (_.isUndefined(result) || (_.isBoolean(result) && result)) ? Promise.resolve() : Promise.reject();
        });
      } else if (_.isFunction(method)) {

        return Promise.method(method)(req)
        .then(function (result) {
          return (_.isUndefined(result) || (_.isBoolean(result) && result)) ? Promise.resolve() : Promise.reject();
        });
      } else {
        return Promise.reject();
      }
    })
    .any()
    .return()
    .catch(function () {
      return Promise.reject(403);
    });
  }

  function executeRoute (req, res, next, routeDef) {
    routeDef = _.defaults(routeDef, {
      authentication: options.defaultAuthentication,
      authorization: options.defaultAuthorization
    });

    var context = {
      req: req,
      res: res,
      skipResponse: function () { return new SkipResponse();  },
      response: function (statusCode, mimeType, body) { return new Response(statusCode, mimeType, body); }
    };
    // Make sure the routeDef actually exists, could be a 404.
    if (_.isObject(routeDef) || _.isFunction(routeDef)) {
      return authenticate(req, res, routeDef.authentication)
      .then(function () {
        if (!_.isNull(routeDef.authentication)) {
          return authorize(req, routeDef.authorization);
        }
      })
      .then(function () {
        var route = _.isFunction(routeDef) ? routeDef : routeDef.action;
        return Promise.method(route).call(context, req, res)
        .then(function (result) {
          if (result instanceof SkipResponse) {
            return;
          } else if (result instanceof Response) {
            if (_.isUndefined(result.mimeType)) {
              res.status(result.statusCode).json(result.body);
            } else {
              res.status(result.statusCode).type(result.mimeType).send(result.body);
            }
          } else if (_.isUndefined(result) && !res.headersSent) {
            res.status(204).end();
          } else if (_.isNumber(result)) {
            res.status(result).end();
          } else {
            res.status(200).json(_.has(result, 'toJSON') ? result.toJSON() : result);
          }
        });
      })
      .catch(validationError, function (error) {
        return res.status(400).json({ validationErrors: error.errors });
      })
      .catch(function (code) {
        if (code === 401) {
          options.traceLogger('authentication failed');
          res.status(401).end();
        } else if (code === 403) {
          options.traceLogger('authorization failed');
          res.status(403).end();
        } else if (_.isNumber(code)) {
          res.status(code).end();
        } else {
          options.errorLogger(code.stack || code);
          res.status(500).end();
        }
      });
    } else {
      res.status(404).end();
      return Promise.resolve();
    }
  }

  var register = function (controllerName, controllerDefinition, prefix) {
    if (_.isObject(controllerName)) {
      controllerDefinition = controllerName;
      controllerName = null;
    }

    prefix = prefix || '';
    var controllerPrefix = _.isNull(controllerName) ? '' : prefix + '/' + controllerName;
    routeCache[controllerPrefix] = controllerDefinition;

    _.each(_.keys(controllerDefinition), function (route) {
      var chain = apiRouter.route(controllerPrefix + (route === '/' ? '' : route));

      if (controllerDefinition[route].get || controllerDefinition[route].GET) {
        chain = chain.get(function (req, res, next) {
          options.traceLogger('Hit GET handler for %s on %s', route, controllerName);
          return executeRoute(req, res, next, controllerDefinition[route].get || controllerDefinition[route].GET);
        });
      }
      
      if (controllerDefinition[route].put || controllerDefinition[route].PUT) {
        chain = chain.put(function (req, res, next) {
          options.traceLogger('Hit PUT handler for %s on %s', route, controllerName);
          if (route === '/') {
          // Explicitly disallow PUTs on the index route.
            res.responder(404);
          } else {
            return executeRoute(req, res, next, controllerDefinition[route].put || controllerDefinition[route].PUT);
          }
        });
      }

      if (controllerDefinition[route].post || controllerDefinition[route].POST) {
        chain = chain.post(function (req, res, next) {
          options.traceLogger('Hit POST handler for %s on %s', route, controllerName);
          executeRoute(req, res, next, controllerDefinition[route].post || controllerDefinition[route].POST);
        });
      }
      
      if (controllerDefinition[route].delete || controllerDefinition[route].DELETE) {
        chain = chain.delete(function (req, res, next) {
          options.traceLogger('Hit DELETE handler for %s on %s', route, controllerName);
          if (route === '/') {
          // Explicitly disallow DELETEs on the index route.
            res.responder(404);
          } else {
            return executeRoute(req, res, next, controllerDefinition[route].delete || controllerDefinition[route].DELETE);
          }
        });
      }
    });
  };

  var swagger = function (info, options) {
    options = _.defaults(options || {}, {
      enableUI: false,
      basePath: '/'
    });

    return new Promise(function (resolve, reject) {
      var swagger = require('swagger-tools');
      var swaggerObject = {
        swagger: '2.0',
        info: info,
        basePath: options.basePath,
        paths: {},
        tags: []
      };

      _.each(routeCache, function (routeDef, controllerName) {
        var name = controllerName.substring(1);
        _.each(routeDef, function (methods, routeName) {
          var parameters = [];
          routeName = routeName.replace(/:\w*/, function (value) {
            var param = value.substring(1);
            parameters.push(param);
            return util.format('{%s}', param);
          });
          swaggerObject.paths[controllerName + routeName] = _.transform(methods, function (result, method, key) {
            key = key.toLowerCase();

            if (_.isFunction(method)) {
              result[key] = {};
            } else {
              result[key] =  _.omit(_.omit(method, ['action', 'authorization', 'authentication']), _.isUndefined);
            }

            if (_.isUndefined(result[key].tags)) {
              result[key].tags = [];
            }
            result[key].tags.push(name);

            if (_.isUndefined(result[key].responses)) {
              result[key].responses = {
                default: {
                  description: 'This is a placeholder response. Please define one on your controller.'
                }
              };
            }

            if (parameters.length > 0) {
              var params = _.map(parameters, function (param) {
                return {
                  name: param,
                  in: 'path',
                  type: 'string'
                };
              });
              if (_.isUndefined(result[key].parameters)) {
                result[key].parameters = params;
              } else {
                result[key].parameters.concat(params);
              }
            }
          });
        });

        swaggerObject.tags.push({
          name: name,
          description: util.format('Operations under the %s controller.', name)
        });
      });

      swagger.specs.v2.validate(swaggerObject, function (err, result) {
        if (err || result) {
          reject(result.errors);
        } else {
          priorityRouter.use(function (req, res, next) {
            if (_.isUndefined(req.headers.authentication) && req.query.api_key) {
              req.headers.authorization = 'Bearer ' + req.query.api_key;
            }
            next();
          });
          swagger.initializeMiddleware(swaggerObject, function (middleware) {
            if (options.enableUI) {
              priorityRouter.use(middleware.swaggerUi({
                apiDocs: '/swagger.json',
                swaggerUi: '/swagger'
              }));
            } else {
              priorityRouter.route('/swagger/')
              .all(function (req, res) {
                res.status(404).end();
              });
              priorityRouter.route('/swagger.json')
              .get(function (req, res) {
                res.status(200).json(swaggerObject);
              });
            }
            resolve(swaggerObject);
          });
        }
      });
    });
  };

  var router = express.Router();
  router.use(priorityRouter);
  router.use(apiRouter);

  router.register = register;
  router.swagger = swagger;

  return router;
};