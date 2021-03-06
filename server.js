var cluster = require('cluster');
var numCPUs = require('os').cpus().length;
var express = require('express');
var app = express();
var path = require('path');
var mongoose = require('mongoose');
var passport = require('passport');
var LocalStrategy = require('passport-local').Strategy;
var BasicStrategy = require('passport-http').BasicStrategy;
var BearerStrategy = require('passport-http-bearer').Strategy;
var crypto = require('crypto');
var jwt = require('jsonwebtoken');
var morgan = require('morgan');
var bodyParser = require('body-parser');
var errorHandler = require('errorhandler');
var methodOverride = require('method-override');
var session = require('express-session');
var busboy = require('connect-multiparty');
//load project modules & configs);
var config = require('./config/app');
var redisClient = require('./app/utils').redisClient;
var allowCrossDomain = function(req, res, next) {
  res.header("Access-Control-Allow-Origin", req.headers.origin);
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Methods", "GET,PUT,DELETE,POST,OPTIONS,PATCH");
  next();
};
mongoose.connect(config.url);

var db = mongoose.connection;

db.on('error', console.error.bind(console, 'connection error'));

db.on('open', function () {
  //clustering implementation on CPU cores
  if (cluster.isMaster) {
  // Fork workers.
  for (var i = 0; i < 1; i++) {
    cluster.fork();
  }

  cluster.on('exit', function(worker, code, signal) {
    console.log('worker ' + worker.process.pid + ' died');
  });

  cluster.on('disconnect', function(worker) {
    console.error('disconnect!');
    cluster.fork();
  });

  } else {
    runServer();
  }
});

var runServer = function() {
  app.use(morgan('dev'));
  app.use(express.static(__dirname + '/frontend'));
  app.set('port', process.env.PORT || 8080);
  app.use(allowCrossDomain);
  app.use(bodyParser.json());
  app.use(bodyParser({ keepExtensions: true, uploadDir: __dirname + "/public/uploads" }));
  app.use(bodyParser.urlencoded({
   extended: true
  }));
  app.use(methodOverride());
  if ('development' == app.get('env')) {
    app.use(errorHandler());
  }

  passport.use(new BasicStrategy(
  function(username, password, done) {
    User.findOne({username: username}, function (err, user) {
      if (err) { return done(err); }
      if (!user) { return done(null, false); }
      if (user.hash != crypto.pbkdf2Sync(password, user.salt, 25000, 512, 'hmac-sha1').toString('hex')) {
        return done(null, false);
      }
      return done(null, user);
    });
  }));

  //check redis for token
  passport.use(new BearerStrategy(
  function(token, done) {
    redisClient.get(token, function(err, user_id) {
      if (err) return done(err);
      if (!user_id) return done(null, false);
      User.findOne({_id: user_id}, function(err, user) {
        if (err) return done(err);
        if (!user) return done(null, false);
        return done(null, user, {scope: 'all', token: token});
      });
    });
  }));

  app.use(session({secret: config.app_secret,
                resave : false,
                saveUninitialized: false}));
  app.use(passport.initialize());
  app.use(passport.session());

  var User = require('./app/models/user');

  passport.use(User.createStrategy());
  passport.serializeUser(User.serializeUser());
  passport.deserializeUser(User.deserializeUser());

  //middleware for checking if user's logged in
  var localauth = function(req, res, next) {
    if (req.isAuthenticated()) return next();
    else {
      res.send({error: 'unauthorized'}, 401);
    }
  };

  var auth = passport.authenticate(['bearer', 'basic'], {session: false});

  //middleware for checking if user's owner
  var isOwner = function(req, res, next) {
    if (req.user._id == req.body.user_id) return next();
    else {
      res.send({error: 'unauthorized'}, 401);
    }
  };

  app.get('/', express.static(path.join(__dirname, '/frontend')));
  app.get('/api', function(req,res) {
    res.send({'message': 'api is running', 'status': res.status});
  });
  require('./app/routes/api/authenticate')(app);
  require('./app/routes/api/user')(app, localauth, auth, isOwner);
  require('./app/routes/api/event')(app, localauth, auth, isOwner);
  require('./app/routes/api/vote')(app, localauth, auth, isOwner);
  require('./app/routes/api/comment')(app, localauth, auth, isOwner);
  require('./app/routes/api/media')(app, localauth, auth, isOwner);
  //app listen port 8080
  app.listen(8080);
  console.log('Worker ' + cluster.worker.id + ' running!');
};


