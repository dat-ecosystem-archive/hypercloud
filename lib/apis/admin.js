const {NotFoundError, UnauthorizedError, ForbiddenError} = require('../const')
const lock = require('../lock')

// exported api
// =

module.exports = class AdminAPI {
  constructor (cloud) {
    this.usersDB = cloud.usersDB
    this.archiver = cloud.archiver
    this.mailer = cloud.mailer
    this.config = cloud.config
  }

  async listUsers (req, res) {
    // check perms
    if (!res.locals.session) throw new UnauthorizedError()
    if (!res.locals.session.scopes.includes('admin:users')) throw new ForbiddenError()

    // fetch
    var users = await this.usersDB.list({
      cursor: req.query.cursor,
      limit: req.query.limit ? +req.query.limit : 25,
      sort: req.query.sort,
      reverse: +req.query.reverse === 1
    })

    // respond
    res.status(200)
    res.json({users})
  }

  async getUser (req, res) {
    // check perms
    if (!res.locals.session) throw new UnauthorizedError()
    if (!res.locals.session.scopes.includes('admin:users')) throw new ForbiddenError()

    // fetch
    var user = await this._getUser(req.params.id)

    // respond
    res.status(200)
    res.json(user)
  }

  async createUser (req, res) {
    // check perms
    if (!res.locals.session) throw new UnauthorizedError()
    if (!res.locals.session.scopes.includes('admin:users')) throw new ForbiddenError()

    // validate & sanitize input
    req.checkBody('username')
      .isAlphanumeric().withMessage('Can only be letters and numbers.')
      .isLength({ min: 3, max: 16 }).withMessage('Must be 3 to 16 characters.')
    req.checkBody('email', 'Must be a valid email').optional()
      .isEmail()
      .isLength({ min: 3, max: 100 })
    req.checkBody('password', 'Must be 6 to 100 characters.').optional()
      .isLength({ min: 6, max: 100 })
    ;(await req.getValidationResult()).throw()
    var {username, email, password} = req.body

    var release = await lock('users')
    try {
      // check email & username availability
      let error = false
      if (email && await this.usersDB.isEmailTaken(email)) {
        error = {
          message: 'Email is not available',
          emailNotAvailable: true
        }
      } else if (await this.usersDB.isUsernameTaken(username)) {
        error = {
          message: 'Username is not available',
          usernameNotAvailable: true
        }
      }

      // render error
      if (error) {
        return res.status(422).json(error)
      }

      // create user record
      var record = await this.usersDB.create({
        username,
        email,
        password
      })
    } finally {
      release()
    }

    // respond
    res.status(201)
    res.json({id: record.id, email: record.email})
  }

  async updateUser (req, res) {
    // check perms
    if (!res.locals.session) throw new UnauthorizedError()
    if (!res.locals.session.scopes.includes('admin:users')) throw new ForbiddenError()

    // validate & sanitize input
    req.checkBody('username').optional()
      .isAlphanumeric().withMessage('Can only be letters and numbers.')
      .isLength({ min: 3, max: 16 }).withMessage('Must be 3 to 16 characters.')
    req.checkBody('email', 'Must be a valid email').optional()
      .isEmail()
      .isLength({ min: 3, max: 100 })
    req.checkBody('scopes', 'Must be an array of strings.').optional()
      .isScopesArray()
    req.checkBody('diskQuota', 'Must be a byte size.').optional()
      .isBytes()
    ;(await req.getValidationResult()).throw()
    if (req.body.diskQuota) req.sanitizeBody('diskQuota').toBytes()
    var {username, email, scopes, diskQuota} = req.body

    var release = await lock('users')
    try {
      // fetch
      var user = await this._getUser(req.params.id)

      // update
      if (typeof username !== 'undefined') user.username = username
      if (typeof email !== 'undefined') user.email = email
      if (typeof scopes !== 'undefined') user.scopes = scopes
      if (typeof diskQuota !== 'undefined') user.diskQuota = diskQuota
      await this.usersDB.put(user)
    } finally {
      release()
    }

    // respond
    res.status(200)
    res.json(user)
  }

  async suspendUser (req, res) {
    // check perms
    if (!res.locals.session) throw new UnauthorizedError()
    if (!res.locals.session.scopes.includes('admin:users')) throw new ForbiddenError()

    var release = await lock('users')
    try {
      // fetch user record
      var user = await this._getUser(req.params.id)

      // update record
      var scopeIndex = user.scopes.indexOf('user')
      if (scopeIndex !== -1) user.scopes.splice(scopeIndex, 1)
      user.suspension = req.body && req.body.reason ? req.body.reason : true
      await this.usersDB.put(user)
    } finally {
      release()
    }

    // respond
    res.status(200).end()
  }

  async unsuspendUser (req, res) {
    // check perms
    if (!res.locals.session) throw new UnauthorizedError()
    if (!res.locals.session.scopes.includes('admin:users')) throw new ForbiddenError()

    var release = await lock('users')
    try {
      // fetch user record
      var user = await this._getUser(req.params.id)

      // update record
      var scopeIndex = user.scopes.indexOf('user')
      if (scopeIndex === -1) user.scopes.push('user')
      user.suspension = null
      await this.usersDB.put(user)
    } finally {
      release()
    }

    // respond
    res.status(200).end()
  }

  async getArchive (req, res) {
    // check perms
    if (!res.locals.session) throw new UnauthorizedError()
    if (!res.locals.session.scopes.includes('admin:users')) throw new ForbiddenError()

    // fetch from memory
    var archive = await this.archiver.getArchive(req.params.key)
    if (!archive) {
      throw new NotFoundError()
    }
    res.status(200)
    res.json({
      key: req.params.key,
      numPeers: archive.numPeers,
      manifest: await this.archiver.getManifest(req.params.key),
      swarmOpts: archive.swarmOpts,
      diskUsage: archive.diskUsage
    })
  }

  async sendEmail (req, res) {
    // check perms
    if (!res.locals.session) throw new UnauthorizedError()
    if (!res.locals.session.scopes.includes('admin:users')) throw new ForbiddenError()

    var {message, subject, username} = req.body
    if (!(message && subject && username)) {
      return res.status(422).json({
        message: 'Must include a message and subject line'
      })
    }

    // fetch user record
    var userRecord = await this.usersDB.getByUsername(username)

    if (!userRecord) throw new NotFoundError()

    this.mailer.send('support', {
      email: userRecord.email,
      subject,
      message,
      username,
      brandname: this.config.brandname
    })
    res.status(200).end()
  }

  async _getUser (id) {
    // try to fetch by id, username, and email
    var user = await this.usersDB.getByID(id)
    if (user) return user

    user = await this.usersDB.getByUsername(id)
    if (user) return user

    user = await this.usersDB.getByEmail(id)
    if (user) return user

    throw new NotFoundError()
  }
}
