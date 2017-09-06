/* global Node, requestAnimationFrame */
var yo = require('yo-yo')
var csjs = require('csjs-inject')
var javascriptserialize = require('javascript-serialize')
var jsbeautify = require('js-beautify')
var type = require('component-type')
var vm = require('vm')
var EventManager = require('ethereum-remix').lib.EventManager
var Web3 = require('web3')

var executionContext = require('../../execution-context')
var Dropdown = require('../ui/dropdown')

var css = csjs`
  .panel              {
    position          : relative;
    display           : flex;
    flex-direction    : column;
    font-size         : 12px;
    font-family       : monospace;
    color             : #777;
    background-color  : #ededed;
    height            : 100%;
    min-height        : 1.7em;
    overflow          : hidden;
  }

  .bar                {
    display           : flex;
    min-height        : 1.7em;
    padding           : 2px;
    background-color  : #eef;
    z-index           : 3;
  }
  .menu               {
    position          : relative;
    display           : flex;
    align-items       : center;
    width             : 100%;
    padding           : 5px;
  }
  .minimize           {
    margin-left       : auto;
    width             : 10px;
    cursor            : pointer;
    color             : black;
  }
  .clear              {
    margin-right      : 5px;
    font-size         : 15px;
    cursor            : pointer;
    color             : black;
  }
  .hover              {
    color             : orange;
  }

  .terminal           {
    display           : flex;
    flex-direction    : column;
    height            : 100%;
    padding-left      : 5px;
    padding-right     : 5px;
    padding-bottom    : 3px;
    overflow-y        : auto;
    font-family       : monospace;
  }
  .journal            {
    margin-top        : auto;
    font-family       : monospace;
  }
  .block              {
    word-break        : break-all;
    white-space       : pre-wrap;
    line-height       : 2ch;
    margin            : 1ch;
  }
  .cli                {
    line-height       : 1.7em;
    font-family       : monospace;
  }
  .prompt             {
    margin-right      : 0.5em;
    font-family       : monospace;
  }
  .input              {
    word-break        : break-all;
    outline           : none;
    font-family       : monospace;
  }
  .filter             {
    padding           : 3px;
    width             : 20em;    
  }

  .dragbarHorizontal  {
    position          : absolute;
    top               : 0;
    height            : 0.5em;
    right             : 0;
    left              : 0;
    cursor            : ns-resize;
    z-index           : 999;
    border-top        : 2px solid hsla(215, 81%, 79%, .3);
  }
  .ghostbar           {
    position          : absolute;
    height            : 6px;
    background-color  : #C6CFF7;
    opacity           : 0.5;
    cursor            : row-resize;
    z-index           : 9999;
    left              : 0;
    right             : 0;
  }
`

var KONSOLES = []

function register (api) { KONSOLES.push(api) }

var ghostbar = yo`<div class=${css.ghostbar}></div>`

class Terminal {
  constructor (opts = { auto: true }) {
    var self = this
    self.event = new EventManager()
    self._api = opts.api
    self.data = {
      lineLength: opts.lineLength || 80,
      session: [],
      banner: opts.banner,
      activeFilters: { commands: {}, input: '' }
    }
    self._view = { el: null, bar: null, input: null, term: null, journal: null, cli: null }
    self._components = {}
    self._components.dropdown = new Dropdown({
      options: [
        'knownTransaction',
        'unknownTransaction',
        'script'
      ],
      defaults: ['knownTransaction', 'script']
    })
    self._components.dropdown.event.register('deselect', function (label) {
      self.updateJournal({ type: 'deselect', value: label })
    })
    self._components.dropdown.event.register('select', function (label) {
      self.updateJournal({ type: 'select', value: label })
    })
    self._commands = {}
    self.commands = {}
    self._JOURNAL = []
    self._jobs = []
    self._INDEX = {}
    self._INDEX.all = []
    self._INDEX.allMain = []
    self._INDEX.commands = {}
    self._INDEX.commandsMain = {}
    self.registerCommand('log', self._blocksRenderer('log'))
    self.registerCommand('info', self._blocksRenderer('info'))
    self.registerCommand('error', self._blocksRenderer('error'))
    self.registerCommand('script', function execute (args, scopedCommands, append) {
      var script = String(args[0])
      scopedCommands.log(`> ${script}`)
      self._shell(script, scopedCommands, function (error, output) {
        if (error) scopedCommands.error(error)
        else scopedCommands.log(output)
      })
    })
    self._jsSandboxContext = {}
    self._jsSandbox = vm.createContext(self._jsSandboxContext)
    if (opts.shell) self._shell = opts.shell
    register(self)
  }
  render () {
    var self = this
    if (self._view.el) return self._view.el
    self._view.journal = yo`<div class=${css.journal}></div>`
    self._view.input = yo`
      <span class=${css.input} contenteditable="true" onkeydown=${change}></span>
    `
    self._view.cli = yo`
      <div class=${css.cli}>
        <span class=${css.prompt}>${'>'}</span>
        ${self._view.input}
      </div>
    `
    self._view.icon = yo`<i onmouseenter=${hover} onmouseleave=${hover} onmousedown=${minimize} class="${css.minimize} fa fa-angle-double-down"></i>`
    self._view.dragbar = yo`<div onmousedown=${mousedown} class=${css.dragbarHorizontal}></div>`
    self._view.dropdown = self._components.dropdown.render()
    self._view.bar = yo`
      <div class=${css.bar}>
        ${self._view.dragbar}
        <div class=${css.menu}>
          <div class=${css.clear} onclick=${clear}>
            <i class="fa fa-ban" aria-hidden="true" onmouseenter=${hover} onmouseleave=${hover}></i>
          </div>
          ${self._view.dropdown}
          <input type="text" class=${css.filter} onkeyup=${filter}></div>
          ${self._view.icon}
        </div>
      </div>
    `
    self._view.term = yo`
      <div class=${css.terminal} onscroll=${throttle(reattach, 10)} onclick=${focusinput}>
        ${self._view.journal}
        ${self._view.cli}
      </div>
    `
    self._view.el = yo`
      <div class=${css.panel}>
        ${self._view.bar}
        ${self._view.term}
      </div>
    `
    if (self.data.banner) self.commands.log(self.data.banner)

    function throttle (fn, wait) {
      var time = Date.now()
      return function debounce () {
        if ((time + wait - Date.now()) < 0) {
          fn.apply(this, arguments)
          time = Date.now()
        }
      }
    }
    var css2 = csjs`
      .anchor            {
        position         : static;
        border-top       : 2px dotted blue;
        height           : 10px;
      }
      .overlay           {
        position         : absolute;
        width            : 100%;
        display          : flex;
        align-items      : center;
        justify-content  : center;
        bottom           : 0;
        right            : 15px;
        height           : 20%;
        min-height       : 50px;
      }
      .text              {
        z-index          : 2;
        color            : black;
        font-size        : 25px;
        font-weight      : bold;
        pointer-events   : none;
      }
      .background        {
        z-index          : 1;
        opacity          : 0.8;
        background-color : #a6aeba;
        cursor           : pointer;
      }
    `
    var text = yo`<div class="${css2.overlay} ${css2.text}"></div>`
    var background = yo`<div class="${css2.overlay} ${css2.background}"></div>`
    var placeholder = yo`<div class=${css2.anchor}>${background}${text}</div>`
    var inserted = false

    function focusinput (event) {
      if (self._view.journal.offsetHeight - (self._view.term.scrollTop + self._view.term.offsetHeight) < 50) {
        refocus()
      }
    }
    function refocus () {
      self._view.input.focus()
      reattach({ currentTarget: self._view.term })
      delete self.scroll2bottom
      self.scroll2bottom()
    }
    function reattach (event) {
      var el = event.currentTarget
      var isBottomed = el.scrollHeight - el.scrollTop - el.clientHeight < 30
      if (isBottomed) {
        if (inserted) {
          text.innerText = ''
          background.onclick = undefined
          self._view.journal.removeChild(placeholder)
        }
        inserted = false
        delete self.scroll2bottom
      } else {
        if (!inserted) self._view.journal.appendChild(placeholder)
        inserted = true
        check()
        if (!placeholder.nextElementSibling) {
          placeholder.style.display = 'none'
        } else {
          placeholder.style = ''
        }
        self.scroll2bottom = function () {
          var next = placeholder.nextElementSibling
          if (next) {
            placeholder.style = ''
            check()
            var messages = 1
            while ((next = next.nextElementSibling)) messages += 1
            text.innerText = `${messages} new unread log entries`
          } else {
            placeholder.style.display = 'none'
          }
        }
      }
    }
    function check () {
      var pos1 = self._view.term.offsetHeight + self._view.term.scrollTop - (self._view.el.offsetHeight * 0.15)
      var pos2 = placeholder.offsetTop
      if ((pos1 - pos2) > 0) {
        text.style.display = 'none'
        background.style.position = 'relative'
        background.style.opacity = 0.3
        background.style.right = 0
        background.style.borderBox = 'content-box'
        background.style.padding = '2px'
        background.style.height = (self._view.journal.offsetHeight - (placeholder.offsetTop + placeholder.offsetHeight)) + 'px'
        background.onclick = undefined
        background.style.cursor = 'default'
        background.style.pointerEvents = 'none'
      } else {
        background.style = ''
        text.style = ''
        background.onclick = function (event) {
          placeholder.scrollIntoView()
          check()
        }
      }
    }
    function hover (event) { event.currentTarget.classList.toggle(css.hover) }
    function minimize (event) {
      event.preventDefault()
      event.stopPropagation()
      if (event.button === 0) {
        var classList = self._view.icon.classList
        classList.toggle('fa-angle-double-down')
        classList.toggle('fa-angle-double-up')
        self.event.trigger('resize', [])
      }
    }
    function filter (event) {
      var input = event.currentTarget
      self.updateJournal({ type: 'search', value: input.value })
    }
    function clear (event) {
      refocus()
      self._view.journal.innerHTML = ''
    }
    // ----------------- resizeable ui ---------------
    function mousedown (event) {
      event.preventDefault()
      if (event.which === 1) {
        moveGhostbar(event)
        document.body.appendChild(ghostbar)
        document.addEventListener('mousemove', moveGhostbar)
        document.addEventListener('mouseup', removeGhostbar)
        document.addEventListener('keydown', cancelGhostbar)
      }
    }
    function cancelGhostbar (event) {
      if (event.keyCode === 27) {
        document.body.removeChild(ghostbar)
        document.removeEventListener('mousemove', moveGhostbar)
        document.removeEventListener('mouseup', removeGhostbar)
        document.removeEventListener('keydown', cancelGhostbar)
      }
    }
    function moveGhostbar (event) { // @NOTE HORIZONTAL ghostbar
      ghostbar.style.top = self._api.getPosition(event) + 'px'
    }
    function removeGhostbar (event) {
      if (self._view.icon.classList.contains('fa-angle-double-up')) {
        self._view.icon.classList.toggle('fa-angle-double-down')
        self._view.icon.classList.toggle('fa-angle-double-up')
      }
      document.body.removeChild(ghostbar)
      document.removeEventListener('mousemove', moveGhostbar)
      document.removeEventListener('mouseup', removeGhostbar)
      document.removeEventListener('keydown', cancelGhostbar)
      self.event.trigger('resize', [self._api.getPosition(event)])
    }

    return self._view.el

    function change (event) {
      if (event.which === 13) {
        if (event.ctrlKey) { // <ctrl+enter>
          self._view.input.appendChild(document.createElement('br'))
          self.scroll2bottom()
          putCursor2End(self._view.input)
        } else { // <enter>
          event.preventDefault()
          self.commands.script(self._view.input.innerText)
          self._view.input.innerHTML = ''
        }
      }
    }
    function putCursor2End (editable) {
      var range = document.createRange()
      range.selectNode(editable)
      var child = editable
      var chars

      while (child) {
        if (child.lastChild) child = child.lastChild
        else break
        if (child.nodeType === Node.TEXT_NODE) {
          chars = child.textContent.length
        } else {
          chars = child.innerHTML.length
        }
      }

      range.setEnd(child, chars)
      var toStart = true
      var toEnd = !toStart
      range.collapse(toEnd)

      var sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)

      editable.focus()
    }
  }
  updateJournal (filterEvent) {
    var self = this
    var commands = self.data.activeFilters.commands
    var value = filterEvent.value
    if (filterEvent.type === 'select') {
      commands[value] = true
      if (!self._INDEX.commandsMain[value]) return
      self._INDEX.commandsMain[value].forEach(item => {
        item.root.steps.forEach(item => { self._JOURNAL[item.gidx] = item })
        self._JOURNAL[item.gidx] = item
      })
    } else if (filterEvent.type === 'deselect') {
      commands[value] = false
      if (!self._INDEX.commandsMain[value]) return
      self._INDEX.commandsMain[value].forEach(item => {
        item.root.steps.forEach(item => { self._JOURNAL[item.gidx] = undefined })
        self._JOURNAL[item.gidx] = undefined
      })
    } else if (filterEvent.type === 'search') {
      if (value !== self.data.activeFilters.input) {
        var query = self.data.activeFilters.input = value
        var items = self._JOURNAL
        for (var gidx = 0, len = items.length; gidx < len; gidx++) {
          var item = items[gidx]
          if (item) {
            var show = query.length ? match(item.args, query) : true
            item.hide = !show
          }
        }
      }
    }
    var df = document.createDocumentFragment()
    self._JOURNAL.forEach(item => {
      if (item && item.el && !item.hide) df.appendChild(item.el)
    })
    requestAnimationFrame(function updateDOM () {
      self._view.journal.innerHTML = ''
      self._view.journal.appendChild(df)
    })
  }
  _shouldAdd (item) {
    var self = this
    if (self.data.activeFilters.commands[item.root.cmd]) {
      var query = self.data.activeFilters.input
      var args = item.args
      return query.length ? match(args, query) : true
    }
  }
  _appendItem (item) {
    var self = this
    var { el, gidx } = item
    self._JOURNAL[gidx] = item
    if (!self._jobs.length) {
      requestAnimationFrame(function updateTerminal () {
        self._jobs.forEach(el => self._view.journal.appendChild(el))
        self.scroll2bottom()
        self._jobs = []
      })
    }
    self._jobs.push(el)
  }
  scroll2bottom () {
    var self = this
    setTimeout(function () {
      self._view.term.scrollTop = self._view.term.scrollHeight
    }, 0)
  }
  _blocksRenderer (mode) {
    var self = this
    mode = { log: 'black', info: 'blue', error: 'red' }[mode] // defaults
    if (mode) {
      return function logger (args, scopedCommands, append) {
        var types = args.map(type)
        var values = javascriptserialize.apply(null, args).map(function (val, idx) {
          if (typeof args[idx] === 'string') val = args[idx]
          if (types[idx] === 'element') val = jsbeautify.html(val)
          var pattern = '.{1,' + self.data.lineLength + '}'
          var lines = val.match(new RegExp(pattern, 'g'))
          return lines.map(str => document.createTextNode(`${str}\n`))
        })
        append(yo`<span style="color: ${mode};">${values}</span>`)
      }
    } else {
      throw new Error('mode is not supported')
    }
  }
  _scopeCommands (append) {
    var self = this
    var scopedCommands = {}
    Object.keys(self.commands).forEach(function makeScopedCommand (cmd) {
      var command = self._commands[cmd]
      scopedCommands[cmd] = function _command () {
        var args = [...arguments]
        command(args, scopedCommands, el => append(cmd, args, blockify(el)))
      }
    })
    return scopedCommands
  }
  registerCommand (name, command) {
    var self = this
    name = String(name)
    if (self._commands[name]) throw new Error(`command "${name}" exists already`)
    if (typeof command !== 'function') throw new Error(`invalid command: ${command}`)
    self._commands[name] = command
    self._INDEX.commands[name] = []
    self._INDEX.commandsMain[name] = []
    self.commands[name] = function _command () {
      var args = [...arguments]
      var steps = []
      var root = { steps, cmd: name }
      var ITEM = { root, cmd: name }
      root.gidx = self._INDEX.allMain.push(ITEM) - 1
      root.idx = self._INDEX.commandsMain[name].push(ITEM) - 1
      function append (cmd, params, el) {
        var item
        if (cmd) { // subcommand
          item = { el, cmd, root }
        } else { // command
          item = ITEM
          item.el = el
          cmd = name
        }
        item.gidx = self._INDEX.all.push(item) - 1
        item.idx = self._INDEX.commands[cmd].push(item) - 1
        item.step = steps.push(item) - 1
        item.args = params
        if (self._shouldAdd(item)) self._appendItem(item)
      }
      var scopedCommands = self._scopeCommands(append)
      command(args, scopedCommands, el => append(null, args, blockify(el)))
    }
    var help = typeof command.help === 'string' ? command.help : [
      `// no help available for:`,
      `terminal.commands.${name}(...)`
    ].join('\n')
    self.commands[name].toString = _ => { return help }
    self.commands[name].help = help
    return self.commands[name]
  }
  _shell (script, scopedCommands, done) { // default shell
    var self = this
    var context = domTerminalFeatures(self, scopedCommands)
    try {
      var cmds = vm.createContext(Object.assign(self._jsSandboxContext, context))
      var result = vm.runInContext(script, cmds)
      self._jsSandboxContext = Object.assign({}, context)
      done(null, result)
    } catch (error) {
      done(error.message)
    }
  }
}

function domTerminalFeatures (self, scopedCommands) {
  return {
    web3: executionContext.getProvider() !== 'vm' ? new Web3(executionContext.web3().currentProvider) : null,
    console: {
      log: function () { scopedCommands.log.apply(scopedCommands, arguments) },
      info: function () { scopedCommands.info.apply(scopedCommands, arguments) },
      error: function () { scopedCommands.error.apply(scopedCommands, arguments) }
    }
  }
}

function findDeep (object, fn, found = { break: false, value: undefined }) {
  if (typeof object !== 'object' || object === null) return
  for (var i in object) {
    if (found.break) break
    var el = object[i]
    if (!fn(el, i, object)) findDeep(el, fn, found)
    else if (found.break = true) return found.value = el // eslint-disable-line
  }
  return found.value
}

function match (args, query) {
  query = query.trim()
  var isMatch = !!findDeep(args, function check (value, key) {
    if (value === undefined || value === null) return false
    if (typeof value === 'function') return false
    if (typeof value === 'object') return false
    var contains = String(value).indexOf(query.trim()) !== -1
    return contains
  })
  return isMatch
}

function blockify (el) { return yo`<div class=${css.block}>${el}</div>` }

module.exports = Terminal
