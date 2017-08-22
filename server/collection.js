const router = new (require('koa-router'))({prefix: '/collection'})
  , fs = require('fs')
  , redis = require('./util/redis')
  , uuidv1 = require('uuid/v1');

// get all collections
router.get('/', async function (ctx) {
  const redisClient = redis.getReadConn();
  const collections = await redisClient.hgetallAsync('monitor-man-collection');
  ctx.response.body = [];
  for (let id in collections) {
    const collection = JSON.parse(collections[id]);
    ctx.response.body.push(Object.assign({
      id: id
    }, collection));
  }
});

router.get('/:collectionId/:distribute/failure/:id', async function (ctx) {
  const redisClient = redis.getReadConn();
  ctx.response.body = await redisClient.hgetAsync(
    'monitor-man-summary-failures-' + ctx.params.collectionId + '-' + ctx.params.distribute, ctx.params.id);
});

// get collections by tag
router.get('/tag/:tag', async function (ctx) {
  const redisClient = redis.getReadConn();
  let collectionIds = await redisClient.smembersAsync('monitor-man-tag-'+ctx.params.tag);
  console.log(collectionIds)
  if (!collectionIds) {
    ctx.response.body = [];
    return;
  }
  let collections = await redisClient.hmgetAsync('monitor-man-collection', collectionIds);
  if (!collections) {
    ctx.response.body = [];
    return;
  }
  ctx.response.body = [];
  for (let id in collections) {
    const collection = JSON.parse(collections[id]);
    ctx.response.body.push(Object.assign({
      id: collectionIds[id]
    }, collection));
  }
});

// stop/start collection distribute
router.post('/:id/:distribute/:status', async function (ctx) {
  const redisClient = redis.getReadConn();
  let collectionInfo = await redisClient.hgetAsync('monitor-man-collection', ctx.params.id);
  if (!collectionInfo) {
    ctx.throw(400, 'Collection not found.');
  }
  collectionInfo = JSON.parse(collectionInfo);
  if (collectionInfo.distributes[ctx.params.distribute]) {
    collectionInfo.distributes[ctx.params.distribute].status = ctx.params.status;
    collectionInfo.distributes[ctx.params.distribute].timestamp = Date.now();
    await redisClient.hsetAsync('monitor-man-collection', ctx.params.id, JSON.stringify(collectionInfo));
  }
  ctx.response.body = '';
});

// delete collection
router.delete('/:id', async function (ctx) {
  const collectionId =  ctx.params.id;
  let redisClient = redis.getWriteConn();
  let collectionInfo = await redisClient.hgetAsync('monitor-man-collection',collectionId);
  if (!collectionInfo) {
    ctx.throw(400, 'Collection not found.');
  }
  collectionInfo = JSON.parse(collectionInfo);
  redisClient = redisClient.multi();
  // delete collection file
  redisClient = redisClient.hdel('monitor-man-collectionFile', collectionId);
  // delete summaries
  for (let name in collectionInfo.distributes) {
    redisClient = redisClient.del('monitor-man-summary-failures-'+collectionId+'-'+name);
    redisClient = redisClient.del('monitor-man-summary-'+collectionId+'-'+name);
  }
  // delete iterationdata and environment
  for (let name in collectionInfo.iterationData) {
    redisClient = redisClient.hdel('monitor-man-iterationData', collectionId+'-'+name);
  }
  for (let name in collectionInfo.environment) {
    redisClient = redisClient.hdel('monitor-man-environment', collectionId+'-'+name);
  }
  // delete from tag
  for (let index in collectionInfo.tag) {
    redisClient = redisClient.srem('monitor-man-tag-'+collectionInfo.tag[index], collectionId);
  }
  redisClient = redisClient.hdel('monitor-man-collection', collectionId);
  await redisClient.execAsync();
  // remove tag, if tag does not relate to any collection
  redisClient = redis.getWriteConn();
  for (let index in collectionInfo.tag) {
    const count = await redisClient.scardAsync('monitor-man-tag-' + collectionInfo.tag[index]);
    if (count === 0) {
      await redisClient.sremAsync('monitor-man-tag', collectionInfo.tag[index]);
    }
  }
  ctx.response.body = '';
});

// get collection by id
router.get('/:id', async function (ctx) {
  const redisClient = redis.getReadConn();
  const collectionInfo = await redisClient.hgetAsync('monitor-man-collection', ctx.params.id);
  if (!collectionInfo) {
    ctx.throw(400, 'Collection not found.');
  }
  ctx.response.body = JSON.parse(collectionInfo)
});

// get collection summaries
router.get('/:id/summaries', async function (ctx) {
  let startTime = Date.now() - 2*3600*1000;
  let endTime = '+inf';
  if (ctx.request.query['s'] && ctx.request.query['e']) {
    startTime = ctx.request.query['s'];
    endTime = ctx.request.query['e'];
  }
  if (!ctx.request.query['distributes']) {
    ctx.response.body = {};
    return;
  }
  let distributes = ctx.request.query['distributes'].split(',');
  let summaries = {};
  const redisClient = redis.getReadConn();
  for (let index in distributes) {
    const _summaries= await redisClient.zrangebyscoreAsync('monitor-man-summary-'+ctx.params.id+'-'+distributes[index], startTime, endTime);
    if (_summaries.length > 0) {
      summaries[distributes[index]] = _summaries;
    }
  }
  ctx.response.body = summaries;
});

// post collection for update
router.post('/:id/update', async function (ctx) {
  const collectionId = ctx.params.id;
  let redisClient = redis.getReadConn();
  let collectionInfo = await redisClient.hgetAsync('monitor-man-collection', collectionId);
  if (!collectionInfo) {
    ctx.throw(400, 'Collection not found.');
  }
  collectionInfo = JSON.parse(collectionInfo);
  const oldTag = collectionInfo['tag'];
  collectionInfo['tag'] = ctx.checkBody('tag').optional().default('').value.split(',');
  collectionInfo['tag'] = collectionInfo['tag'].filter(function(n){ return n !== "" });
  collectionInfo['interval'] = ctx.checkBody('interval').isInt().gt(1000).toInt().value;
  collectionInfo['handler'] = ctx.checkBody('handler').optional().default('').value;
  collectionInfo['handlerParams'] = ctx.checkBody('handlerParams').optional().isJSON().default('{}').value;
  collectionInfo['distributeName'] = ctx.checkBody('distributeName').notEmpty().value;
  collectionInfo['distributeValue'] = ctx.checkBody('distributeValue').notEmpty().value;
  collectionInfo.newmanOption['timeoutRequest'] = ctx.checkBody('timeoutRequest').isInt().toInt().value;
  collectionInfo.newmanOption['delayRequest'] = ctx.checkBody('delayRequest').isInt().toInt().value;
  collectionInfo.newmanOption['iterationCount'] = ctx.checkBody('iterationCount').isInt().toInt().value;
  collectionInfo.newmanOption['ignoreRedirects'] = ctx.checkBody('ignoreRedirects').isIn(['true', 'false']).toBoolean().value;
  collectionInfo.newmanOption['insecure'] = ctx.checkBody('insecure').isIn(['true', 'false']).toBoolean().value;
  collectionInfo.newmanOption['bail'] = ctx.checkBody('bail').isIn(['true', 'false']).toBoolean().value;
  if (ctx.errors) {
    ctx.response.status = 400;
    ctx.response.body = ctx.errors;
    return;
  }
  redisClient = redisClient.multi();
  // update collection file
  const collectionFile = ctx.request.body.files.collection;
  if (collectionFile) {
    delete ctx.request.body.files.collection;
    // update collection file
    collectionInfo['collectionFile'] = collectionFile.path;
    collectionInfo['originalCollectionFileName'] = collectionFile.name;
    let collectionFileData = fs.readFileSync(collectionFile.path);
    const cObj = JSON.parse(collectionFileData);
    if (!cObj.info || !cObj.info.name) {
      ctx.throw(400, 'Invalid collection file.');
      return;
    }
    collectionInfo['name'] = cObj.info.name;
    collectionInfo['description'] = cObj.info.description;
    redisClient.hset('monitor-man-collectionFile', collectionId, collectionFileData);
  }
  // update distributes
  const oldDistributes = collectionInfo.distributes;
  console.log(oldDistributes);
  let distributeValue = collectionInfo['distributeValue'].split(',');
  console.log(distributeValue)
  const ts = Date.now();
  for (let distribute in collectionInfo.distributes) {
    // remove distribute
    if (distributeValue.indexOf(distribute) === -1) {
      delete collectionInfo.distributes[distribute];
      delete collectionInfo.iterationData[distribute];
      delete collectionInfo.environment[distribute];
      // remove iterationData, environment
      redisClient = redisClient.hdel('monitor-man-iterationData', collectionId+'-'+distribute)
        .hdel('monitor-man-environment', collectionId+'-'+distribute);
    }
  }
  for (let index in distributeValue) {
    if (oldDistributes[distributeValue[index]]) {
      console.log(collectionInfo.distributes, ts)
      collectionInfo.distributes[distributeValue[index]].timestamp = ts;
    } else {
      collectionInfo.distributes[distributeValue[index]] = {
        status: 'running',
        timestamp: ts
      };
    }
  }
  // update iterationData, environment
  let iterationData = {};
  let environment = {};
  for (let key in ctx.request.body.files) {
    let file = ctx.request.body.files[key];
    let type = key.split('_');
    if (type[0] === 'iterationData') {
      iterationData[type[1]] = {
        type: 'file',
        path: file.path,
        originalName: file.name
      };
    } else if (type[0] === 'environment') {
      environment[type[1]] = {
        type: 'file',
        path: file.path,
        originalName: file.name
      }
    }
  }
  collectionInfo.iterationData = Object.assign(collectionInfo.iterationData, iterationData);
  collectionInfo.environment = Object.assign(collectionInfo.environment, environment);
  redisClient = redisClient.hset('monitor-man-collection', collectionId, JSON.stringify(collectionInfo));

  for (let distribute in iterationData) {
    const fileData = fs.readFileSync(iterationData[distribute].path);
    redisClient = redisClient.hset('monitor-man-iterationData', collectionId+'-'+distribute, fileData);
  }
  for (let distribute in environment) {
    const fileData = fs.readFileSync(environment[distribute].path);
    redisClient = redisClient.hset('monitor-man-environment', collectionId+'-'+distribute, fileData);
  }

  let remTagKeys = [];
  for (let index in oldTag) {
    if (collectionInfo['tag'].indexOf(oldTag[index]) === -1) {
      remTagKeys.push(oldTag[index]);
      const key = 'monitor-man-tag-' + oldTag[index];
      redisClient = redisClient.srem(key, collectionId);
    }
  }
  for (let index in collectionInfo['tag']) {
    if (oldTag.indexOf(collectionInfo['tag'][index]) === -1) {
      const key = 'monitor-man-tag-' + collectionInfo['tag'][index];
      redisClient = redisClient.sadd(key, collectionId);
      redisClient = redisClient.sadd('monitor-man-tag', collectionInfo['tag'][index]);
    }
  }

  await redisClient.execAsync();

  // remove tag, if tag does not relate to any collection
  redisClient = redis.getWriteConn();
  console.log(remTagKeys)
  for (let index in remTagKeys) {
    const count = await redisClient.scardAsync('monitor-man-tag-' + remTagKeys[index]);
    console.log(count, remTagKeys[index])
    if (count === 0) {
      await redisClient.sremAsync('monitor-man-tag', remTagKeys[index]);
    }
  }
  ctx.response.body = '';
});

// create collection
router.post('/', async function (ctx) {
  let collectionInfo = {distributes: {}, newmanOption: {}};
  collectionInfo['tag'] = ctx.checkBody('tag').optional().default('').value.split(',');
  collectionInfo['tag'] = collectionInfo['tag'].filter(function(n){ return n !== "" });
  collectionInfo['interval'] = ctx.checkBody('interval').isInt().gt(1000).toInt().value;
  collectionInfo['handler'] = ctx.checkBody('handler').optional().default('').value;
  collectionInfo['handlerParams'] = ctx.checkBody('handlerParams').optional().isJSON().default('{}').value;
  collectionInfo['distributeName'] = ctx.checkBody('distributeName').notEmpty().value;
  collectionInfo['distributeValue'] = ctx.checkBody('distributeValue').notEmpty().value;
  collectionInfo.newmanOption['timeoutRequest'] = ctx.checkBody('timeoutRequest').isInt().toInt().value;
  collectionInfo.newmanOption['delayRequest'] = ctx.checkBody('delayRequest').isInt().toInt().value;
  collectionInfo.newmanOption['iterationCount'] = ctx.checkBody('iterationCount').isInt().toInt().value;
  collectionInfo.newmanOption['ignoreRedirects'] = ctx.checkBody('ignoreRedirects').isIn(['true', 'false']).toBoolean().value;
  collectionInfo.newmanOption['insecure'] = ctx.checkBody('insecure').isIn(['true', 'false']).toBoolean().value;
  collectionInfo.newmanOption['bail'] = ctx.checkBody('bail').isIn(['true', 'false']).toBoolean().value;
  ctx.checkFile('collection').notEmpty();
  if (ctx.errors) {
    ctx.response.status = 400;
    ctx.response.body = ctx.errors;
    return;
  }

  const collectionFile = ctx.request.body.files.collection;
  delete ctx.request.body.files.collection;
  collectionInfo['collectionFile'] = collectionFile.path;
  collectionInfo['originalCollectionFileName'] = collectionFile.name;
  let collectionFileData = fs.readFileSync(collectionFile.path);
  const cObj = JSON.parse(collectionFileData);
  if (!cObj.info || !cObj.info.name) {
    ctx.throw(400, 'Invalid collection file.');
    return;
  }
  collectionInfo['name'] = cObj.info.name;
  collectionInfo['description'] = cObj.info.description;
  let distributeValue = collectionInfo['distributeValue'].split(',');
  const ts = Date.now();
  for (let index in distributeValue) {
    collectionInfo.distributes[distributeValue[index]] = {
      status: 'running',
      timestamp: ts
    };
  }
  let iterationData = {};
  let environment = {};
  for (let key in ctx.request.body.files) {
    let file = ctx.request.body.files[key];
    let type = key.split('_');
    if (type[0] === 'iterationData') {
      iterationData[type[1]] = {
        type: 'file',
        path: file.path,
        originalName: file.name
      };
    } else if (type[0] === 'environment') {
      environment[type[1]] = {
        type: 'file',
        path: file.path,
        originalName: file.name
      }
    }
  }
  collectionInfo['iterationData'] = iterationData;
  collectionInfo['environment'] = environment;

  const collectionId = uuidv1();
  let redisClient = redis.getWriteConn();

  redisClient = redisClient.multi()
    .hset('monitor-man-collection', collectionId, JSON.stringify(collectionInfo))
    .hset('monitor-man-collectionFile', collectionId, collectionFileData);

  for (let distribute in iterationData) {
    const fileData = fs.readFileSync(iterationData[distribute].path);
    redisClient = redisClient.hset('monitor-man-iterationData', collectionId+'-'+distribute, fileData);
  }
  for (let distribute in environment) {
    const fileData = fs.readFileSync(environment[distribute].path);
    redisClient = redisClient.hset('monitor-man-environment', collectionId+'-'+distribute, fileData);
  }

  if (collectionInfo['tag']) {
    for (let index in collectionInfo['tag']) {
      redisClient = redisClient.sadd('monitor-man-tag-'+collectionInfo['tag'][index], collectionId);
      redisClient = redisClient.sadd('monitor-man-tag', collectionInfo['tag'][index]);
    }
  }

  await redisClient.execAsync();
  ctx.response.body = '';
});

module.exports = router;
