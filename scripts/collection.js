#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');

var _ = require('lodash');
var jp = require('json-pointer');
var jsonPath = require('jsonpath');
var converter = require('api-spec-converter');
var parseDomain = require('parse-domain');
var jsonPatch = require('json-merge-patch');
var YAML = require('js-yaml');
var Promise = require('bluebird');

var makeRequest = require('makeRequest');
var util = require('./util');

var specSources = [
  require('./spec_sources/google'),
  require('./spec_sources/azure')
];

var blackListedUrls = util.readYaml(__dirname + '/spec_sources/blacklist.yaml');

var jsondiffpatch = require('jsondiffpatch').create({
  arrays: {
    includeValueOnMove: true
  },
  objectHash: function(obj, index) {
    // this function is used only to when objects are not equal by ref
    // add swagger specific properties
    return obj._id || obj.id || obj.name || obj.operationId || '$$index:' + index;
  }
});

converter.ResourceReaders.url = function (url) {
  var options = {
    headers: {
      'Accept': 'application/json,*/*',
    }
  };
  return makeRequest('get', url, options)
    .then(([, data]) => data);
}
var program = require('commander');

var errExitCode = 255;
program
  .option('-0', 'allways return 0 as exit code', function () {
    errExitCode = 0;
  });

program
  .command('urls')
  .description('show source url for specs')
  .action(urlsCollection);

program
  .command('refresh')
  .description('run refresh')
  .arguments('[DIR]')
  .action(refreshCollection);

program
  .command('fixup')
  .description('update "fixup.yaml" for specified Swagger')
  .arguments('<Swagger>')
  .action(fixupSwagger);

program
  .command('update')
  .description('run update')
  .arguments('[DIR]')
  .action(updateCollection);

program
  .command('validate')
  .description('validate collection')
  .action(validateCollection);

program
  .command('leads')
  .description('add/remove specs from 3rd-party catalogs')
  .action(updateCatalogLeads);

program
  .command('add')
  .description('add new spec')
  .option('-f, --fixup', 'try to fix spec')
  .option('-s, --service <NAME>', 'supply service name')
  .arguments('<TYPE> <URL>')
  .action(addToCollection);

program.parse(process.argv);

function urlsCollection() {
  _.each(util.getSpecs(), function (swagger) {
    console.log(util.getOriginUrl(swagger));
  });
}

function refreshCollection(dir) {
  _.each(util.getSpecs(dir), function (swagger, filename) {
    console.log(filename);
    assert(util.getSwaggerPath(swagger) === filename);
    util.saveSwagger(swagger);

    var fixupPath = util.getSwaggerPath(swagger, 'fixup.yaml')
    var revertSwagger = _.cloneDeep(swagger);
    revertFixup(fixupPath, revertSwagger);
    saveFixup(fixupPath, revertSwagger, swagger);
  });
}

function fixupSwagger(swaggerPath) {
  var swagger = util.readYaml(swaggerPath);
  util.editFile(util.Yaml2String(swagger))
    .then(function (editedSwagger) {
      editedSwagger = YAML.safeLoad(editedSwagger);
      appendSwaggerFixup(swagger, editedSwagger);
    })
    .done();
}

function updateCollection(dir) {
  var specs = util.getSpecs(dir);
  var files = originUrlsToFilenames(specs);

  getSpecLeads(specs)
   .then(function (leads) {
     var knownUrls = _(specs).values().map(util.getOriginUrl).value();
     return _(leads).pick(knownUrls).values().value();
   })
   .each(lead => {
     return writeSpecFromLead(lead)
       .then(swagger => {
         var newFilename = util.getSwaggerPath(swagger);
         var oldFilename = files[util.getOriginUrl(lead)];
         if (newFilename !== oldFilename)
           throw Error(`Spec was moved from "${oldFilename}" to "${newFilename}"`);
       });
   })
   .done();
}

function validateCollection() {
  var specs = util.getSpecs();

  validatePrefered(specs);

  Promise.mapSeries(_.toPairs(specs), ([filename, swagger]) => {
    console.error('======================== ' + filename + ' ================');
    assert(!_.isEmpty(swagger.paths), 'Spec should have operations');
    //FIXME: check location
    //assert(util.getSwaggerPath(swagger) === filename, 'Incorect location');

    return validateSwagger(swagger)
      .then(({errors, warnings}) => {
        if (warnings)
          logYaml(warnings);
        if (errors) {
          logYaml(errors);
          throw Error('Validation errors detected');
        }
      });
  }).done();
}

function validatePrefered(specs) {
  var preferred = {}
  _.each(specs, function (swagger) {
    var id = util.getApiId(swagger);
    preferred[id] = preferred[id] || [];
    preferred[id].push(swagger.info['x-preferred']);
  });

  _.each(preferred, function (versions, id) {
    if (_.size(versions) === 1) {
      assert(_.isUndefined(versions[0]) || versions[0] === true,
        'Preferred not true in "' + id + '"');
      return;
    }

    var seenTrue = false;
    _.each(versions, function (value) {
      assert(_.isBoolean(value), 'Non boolean value for "x-preferred" in "' + id + '"');
      assert(value !== true || !seenTrue, 'Multiply preferred versions in "' + id + '"');
      seenTrue = value;
    });
  });
}

function addToCollection(type, url, command) {
  var exPatch = {info: {}};
  if (command.service)
    exPatch.info['x-serviceName'] = command.service;

  writeSpec(url, type, exPatch)
    .catch(error => {
      if (!command.fixup)
        throw error;

      return util.editFile(errorToString(error, error.context))
        .then(function (data) {
          //FIXME: regex
          var match = data.match(/^\++ Begin.*$((?:.|\n)*?)^\?+ Swagger.*$((?:.|\n)*?)^[*!~-]/m);
          if (!match || !match[1] || !match[2])
            throw Error('Can not match edited Swagger');

          if (result.spec.type !== 'swagger_2') {
            var editedOrigin = YAML.safeLoad(match[1]);
            appendFixup(getOriginFixupPath(result.spec), serilazeSpec(result.spec), editedOrigin);
          }

          if (!_.isUndefined(result.swagger)) {
            var editedSwagger = YAML.safeLoad(match[2]);
            appendSwaggerFixup(result.swagger, editedSwagger);
          }
        })
    })
    .done();
}

function getOriginFixupPath(spec) {
  return '../fixes/' + encodeURIComponent(spec.source) + '.yaml';
}

function appendSwaggerFixup(swagger, editedSwagger) {
  appendFixup(util.getSwaggerPath(swagger, 'fixup.yaml'), swagger, editedSwagger);
}

function revertFixup(fixupPath, spec) {
  var fixup = util.readYaml(fixupPath);
  if (fixup)
    jsondiffpatch.unpatch(spec, fixup);
}

function saveFixup(fixupPath, spec, editedSpec) {
  var diff = jsondiffpatch.diff(spec, editedSpec);
  if (!_.isEmpty(diff))
    util.saveYaml(fixupPath, diff);
}

function appendFixup(fixupPath, spec, editedSpec) {
  if (_.isEqual(spec, editedSpec))
    return;

  //Before diff we need to unpatch, it's a way to appeand changes
  revertFixup(fixupPath, spec);
  saveFixup(fixupPath, spec, editedSpec);
}

function swaggerToSpecLead(swagger) {
  var spec = {
    info: {
      'x-serviceName': util.getServiceName(swagger),
      'x-origin': util.getOrigin(swagger)
    }
  };
  removeEmpty(spec);
  return spec;
}

function getCatalogsLeads() {
  return Promise.all(_.invokeMap(specSources, _.call))
    .then(function (catalogsLeads) {
      var allLeads = _.flatten(catalogsLeads);
      return _.omit(indexByOriginUrl(allLeads), blackListedUrls);
    });
}

function indexByOriginUrl(leads) {
  return _(leads)
    .groupBy(util.getOriginUrl)
    .mapValues(function (array, url) {
      assert(_.size(array) === 1, `Duplicate leads for '${url}' URL.`);
      return array[0];
    }).value();
}

function getSpecLeads(specs) {
  var leads = indexByOriginUrl(_.map(specs, swaggerToSpecLead));

  return getCatalogsLeads()
    .then(function (catalogsLeads) {
      return _.mapValues(leads, function (lead, url) {
        return catalogsLeads[url] || lead;
      });
    });
}

function originUrlsToFilenames(specs) {
  return _(specs).mapValues(util.getOriginUrl).invert().value();
}

function updateCatalogLeads() {
  var specs = _.pickBy(util.getSpecs(), function (swagger) {
    //TODO: create more generic mechanism
    var providerName = swagger.info['x-providerName'];
    return ['googleapis.com', 'azure.com', 'windows.net'].indexOf(providerName) !== -1;
  });
  var oldSpecs = originUrlsToFilenames(specs);

  getCatalogsLeads()
  .then(function (newSpecs) {
    var oldURLs = _.keys(oldSpecs);
    var newURLs = _.keys(newSpecs);
    var added = _.difference(newURLs, oldURLs);
    var deleted = _.difference(oldURLs, newURLs);

    return Promise.each(added, url => writeSpecFromLead(newSpecs[url]))
      .then(() => {
        _.each(deleted, function (url) {
          console.log('!!! Delete ' + oldSpecs[url]);
        });
      });
  })
  .done();
}

function writeSpecFromLead(lead) {
  var origin = util.getOrigin(lead);
  var source = origin.url;
  var type = converter.getTypeName(origin.format, origin.version);

  var exPatch = _.cloneDeep(lead);
  delete exPatch.info['x-origin'];

  return writeSpec(source, type, exPatch);
}

function writeSpec(source, type, exPatch) {
  var context = {};

  return converter.getSpec(source, type)
    .then(spec => {
      context.spec = spec;

      var fixup = util.readYaml(getOriginFixupPath(spec));
      jsondiffpatch.patch(spec, fixup);

      return convertToSwagger(spec);
    })
    .then(swagger => {
      context.swagger = swagger;

      patchSwagger(swagger, exPatch);

      expandPathTemplates(swagger);
      replaceSpacesInSchemaNames(swagger);
      extractApiKeysFromParameters(swagger);


      return validateAndFix(swagger)
    })
    .then(validation => {
      context.validation = validation;

      if (validation.errors)
        throw Error(errorToString(null, context));

      if (validation.warnings)
        logYaml(validation.warnings);

      util.saveSwagger(context.swagger);
      return context.swagger;
    })
    .catch(e => {
      e.context = context;
      throw e;
    });
}

function validateAndFix(swagger) {
  return validateSwagger(swagger)
    .then(result => {
      if (!result.errors)
        return result;

      if (fixSpec(swagger, result.errors))
        return validateAndFix(swagger);
      else
        return validateSwagger(swagger);
    });
}

//TODO: move into separate lib
var SwaggerMethods = require('swagger-methods');
function extractApiKeysFromParameters(swagger) {
  if (swagger.securityDefinitions || swagger.security)
    return;

  function isApiKeyParam(param) {
    return _.some(
      [
        /^user[-_]?key$/i,
        /^api[-_]?key$/i,
        /^access[-_]?key$/i
      ],
      function (regExp) {
        return regExp.test(param.name);
      }
    );
  }

  var inAllMethods = true;
  var apiKeys = [];
  _.each(swagger.paths, function (path) {
    _(path).pick(SwaggerMethods).map('parameters').each(function (params) {
      var apiKey = _.filter(params, isApiKeyParam);

      if (_.size(apiKey) === 1)
        apiKeys.push(apiKey[0]);
      else
        inAllMethods = false;
    });
  });

  if (!inAllMethods)
    return;

  var paramName = _(apiKeys).map('name').uniq().value();
  if (_.size(paramName) !== 1)
    return;
  paramName = paramName[0];

  var paramIn = _(apiKeys).map('in').uniq().value();
  if (_.size(paramIn) !== 1)
    return;
  paramIn = paramIn[0];

  if (['header', 'query'].indexOf(paramIn) === -1)
    return;

  //Ignore duplicates, and choose longest description.
  var paramDescription = _(apiKeys).map('description').uniq().sortBy(_.size).last();

  swagger.securityDefinitions = {};
  swagger.securityDefinitions[paramName] = {
    type: 'apiKey',
    name: paramName,
    in: paramIn,
    description: paramDescription
  };

  swagger.security = [{}];
  swagger.security[0][paramName] = [];

  _.each(swagger.paths, function (path) {
    _(path).pick(SwaggerMethods).map('parameters').each(function (parameters) {
      _.remove(parameters, function (param) {
        return param.name === paramName && param.in === paramIn;
      });
    });
  });
}

function expandPathTemplates(swagger) {
  var paths = swagger.paths;
  _.each(_.keys(paths), function (path) {
    function applyParameter(pathItem, name, callback) {
      function applyParameterArray(paramArray, callback) {
        var newParamArray = [];
        _.some(paramArray, function (param, index) {
          if (param.name !== name) {
            newParamArray.push(param);
            return;
          }

          assert(param.in === 'path');
          var ret = callback(param);

          if (!_.isUndefined(ret))
            newParamArray.push(ret);
        });

        return newParamArray;

      }

      pathItem.parameters = applyParameterArray(pathItem.parameters, callback)
      _(pathItem).pick(SwaggerMethods).each(function (value) {
        value.parameters = applyParameterArray(value.parameters, callback);
      });
    }

    var pathItem = paths[path];
    var originalPath = path;
    var match;

    while (match = /{\+([^}]*?)}/.exec(path)) {
      var paramName = match[1];
      path = path.replace(match[0], '{' + paramName + '}');
      applyParameter(pathItem, paramName, function(param) {
        param['x-reservedExpansion'] = true;
        return param;
      });
    }

    var parameterNames = [];
    while (match = /{\/([^}]*?)}/.exec(path)) {
      var paramName = match[1];
      path = path.replace(match[0], '/{' + paramName + '}');
      applyParameter(pathItem, paramName, function(param) {
        assert(_.isUndefined(param.required) || param.required === false);
        param.required = true;
        return param;
      });
      parameterNames.unshift(paramName);
    }

    var clonePath = path;
    var clonePathItem = _.cloneDeep(pathItem);
    _.each(parameterNames, function (paramName) {
      clonePath = clonePath.replace('/{' + paramName + '}', '');
      applyParameter(clonePathItem, paramName, function() {
        return; //delete it
      });
      paths[clonePath] = _.cloneDeep(clonePathItem);
    });

    delete paths[originalPath];
    paths[path] = pathItem;
  });
}

function replaceSpacesInSchemaNames(swagger) {
  if (_.isUndefined(swagger.definitions))
      return;

  swagger.definitions = _.mapKeys(swagger.definitions, function (value, key) {
    return replaceSpaces(key);
  });
}

function replaceSpaces(str) {
  return str.replace(/ /g, '_');
}

function fixSpec(swagger, errors) {
  var fixed = false;

  _.each(errors, function (error) {
    var path = error.path;
    try {
      var parentValue = jp.get(swagger, _.dropRight(path));
      var value = jp.get(swagger, path);
    }
    catch(e) {
      //FIXME: sway give path with intermediate $refs in them
      return;
    }

    var newValue;

    switch(error.code) {
      case 'EQUIVALENT_PATH':
        swagger['x-hasEquivalentPaths'] = true;
        break;
      case 'MISSING_PATH_PARAMETER_DEFINITION':
        var field = error.message.match(/: (.+)$/)[1];
        newValue = _.clone(value);
        newValue.parameters = value.parameters || [];
        newValue.parameters.push({
          name: field,
          type: 'string',
          in: 'path',
          required: true
        });
        break;
      case 'OBJECT_MISSING_REQUIRED_PROPERTY_DEFINITION':
        if (_.isUndefined(value.properties))
          break;

        newValue = _.clone(value);
        newValue.required = [];
        _.each(value.required, function (name) {
          if (!_.isUndefined(value.properties[name]))
            newValue.required.push(name);
        });
        if (_.isEmpty(newValue.required))
          delete newValue.required;
        break;
      case 'ONE_OF_MISSING':
        if (value.in === 'path' && !value.required) {
          newValue = _.clone(value)
          newValue.required = true;
        }
        break;
      case 'UNRESOLVABLE_REFERENCE':
        if (value.indexOf(' ') !== -1)
          newValue = value = replaceSpaces(value);

        if (typeof swagger.definitions[value] !== 'undefined')
          newValue = '#/definitions/' + value;
        break;
      case 'DUPLICATE_OPERATIONID':
        //FIXME: find better solutions than strip all 'operationId'
        jsonPath.apply(swagger, '$.paths[*][*].operationId', function (value) {
          return undefined;
        });
        fixed = true;
        break;
      case 'OBJECT_MISSING_REQUIRED_PROPERTY':
        if (error.message === 'Missing required property: version') {
          newValue = _.clone(value);
          newValue.version = '1.0.0';
          break;
        }
        if (value.type === 'array' && _.isUndefined(value.items)) {
          newValue = _.clone(value);
          newValue.items = {};
        }
        break;
      case 'ENUM_MISMATCH':
      case 'INVALID_FORMAT':
      case 'INVALID_TYPE':
        if (_.last(error.path) === 'default') {
          var type = parentValue.type;
          if (_.isString(value) && !_.isUndefined(type) && type !== 'string') {
            try {
              newValue = JSON.parse(value);
            }
            catch (e) {}
          }
          delete parentValue.default;
          //TODO: add warning
          break;
        }

        var match = error.message.match(/^Expected type (\w+) but found type (\w+)$/);
        if (match && match[2] === 'string') {
          try {
            var tmp = JSON.parse(value);
            if (typeof tmp === match[1]) {
              newValue = tmp;
              fixed = true;
              break;
            }
          }
          catch (e) {}
        }
    }
    if (!_.isUndefined(newValue)) {
      jp.set(swagger, path, newValue);
      fixed = true;
    }
  });
  return fixed;
}

function serilazeSpec(spec) {
  var data = {spec: spec.spec};
  if (spec.subResources)
    data.subResources = spec.subResources;
  return data;
}

function errorToString(error, context) {
  var {spec, swagger, validation} = error.context;
  var url = spec.source;

  var result = '++++++++++++++++++++++++++ Begin ' + url + ' +++++++++++++++++++++++++\n';
  if (spec.type !== 'swagger_2' || _.isUndefined(swagger)) {
    result += util.Yaml2String(serilazeSpec(spec));
  }

  result += '???????????????????? Swagger ' + url + ' ????????????????????????????\n';
  if (!_.isUndefined(swagger))
    result += util.Yaml2String(swagger);

  result += '!!!!!!!!!!!!!!!!!!!! Errors ' + url + ' !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n';
  if (validation.errors)
    result += util.Yaml2String(validation.errors);
  else
    result += error.stack + '\n';

  if (validation.warnings) {
    result += '******************** Warnings ' + url + ' ******************************\n';
    result += util.Yaml2String(validation.warnings);
  }
  result += '------------------------- End ' + url + ' ----------------------------\n';
  return result;
}

function validateSwagger(swagger) {
  return converter.getSpec(swagger, 'swagger_2')
    .then(spec => spec.validate())
    .then(result => {
      if (result.errors && swagger['x-hasEquivalentPaths']) {
        _.remove(result.errors, function (error) {
          return (error.code === 'EQUIVALENT_PATH');
        });

        if (_.isEmpty(result.errors))
          result.errors = null;
      }

      return result;
    });
}

function patchSwagger(swagger, exPatch) {
  //use 1.0.0 as default version
  if (_.isUndefined(swagger.info.version))
    swagger.info.version = '1.0.0';

  //Cleanup from common postfixes
  _.some([
      'API Documentation',
      'JSON API',
      'REST API',
      'Web API',
      'RESTful API',
      'API'
    ], function (postfix) {
      var regex = new RegExp('(.*)(^| )' + postfix + '$');
      var match = (swagger.info.title || '').match(regex);
      if (!match)
        return false;
      swagger.info.title = match[1];
      return true;
  });

  removeEmpty(swagger.info);

  applyMergePatch(swagger, exPatch);

  var patch = {};
  var pathComponents = util.getPathComponents(swagger);

  var path = '';
  _.each(pathComponents, function (dir) {
    path += dir + '/';
    var subPatch = util.readYaml(path + 'patch.yaml');

    if (!_.isUndefined(subPatch))
      patch = jsonPatch.merge(patch, subPatch);
  });

  //swagger-converter if title is absent use host as default
  if (swagger.info.title === swagger.host && !_.isUndefined(patch.info.title))
    delete swagger.info.title;

  applyMergePatch(swagger, patch);

  var fixup = util.readYaml(util.getSwaggerPath(swagger, 'fixup.yaml'));
  jsondiffpatch.patch(swagger, fixup);
}

function removeEmpty(obj) {
  if (!_.isObject(obj))
    return;

  _.forEach(obj, function (value, key) {
    removeEmpty(value);
    if (value === '' || _.isEmpty(value))
      delete obj[key];
  });
}

function convertToSwagger(spec) {
  return spec.convertTo('swagger_2')
    .then(swagger => {
      _.merge(swagger.spec.info, {
        'x-providerName': parseHost(swagger.spec),
        'x-origin': {
          format: spec.formatName,
          version: spec.getFormatVersion(),
          url: spec.source
        }
      });
      return swagger.spec;
    });
}

function parseHost(swagger) {
  assert(swagger.host, 'Missing host');
  assert(!/^localhost/.test(swagger.host), 'Can not add localhost API');
  var p = parseDomain(swagger.host);
  p.domain = p.domain.replace(/^www.?/, '')
  p.subdomain = p.subdomain.replace(/^www.?/, '')
  //TODO: use subdomain to detect 'x-serviceName'

  var host = p.tld;
  if (p.domain !== '')
    host = p.domain + '.' + host;

  //Workaround for google API
  if (p.tld === 'googleapis.com')
    host = p.tld;

  assert(host && host !== '');
  return host;
}

//code is taken from 'json-merge-patch' package and simplify to allow only adding props
function applyMergePatch(target, patch) {
  assert(_.isPlainObject(target));

  if (patch === null)
    return;

  var keys = Object.keys(patch);
  _.forEach(patch, function (value, key) {
    assert(value !== null, 'Patch tried to delete property: ' + key);

    if (_.isPlainObject(target[key]))
      return applyMergePatch(target[key], value);

    assert(_.isUndefined(target[key]), 'Patch tried to override property: ' + key);
    target[key] = value;
  });
};

function logYaml(json) {
  console.error(util.Yaml2String(json));
}
