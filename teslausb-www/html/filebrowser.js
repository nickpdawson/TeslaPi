class FileBrowser {
  DEBUG = false;
  splitter_active = false;
  splitter_clickoffset = 0;
  root_path = '';
  root_label = '';
  anchor_elem = undefined;
  dragged_path = undefined;
  cancelUpload = false;
  uploading = false;
  drives = [];
  curdrive = 0;

  constructor(anchor, drives) {
    this.anchor_elem = anchor;
    this.drives = drives;
    this.root_path = drives[this.curdrive].path;
    this.root_label = drives[this.curdrive].label;

    this.anchor_elem.style.position = "relative";
    this.anchor_elem.style.display = "flex";
    this.anchor_elem.spellcheck = false;
    this.anchor_elem.innerHTML =
    `
      <div class="cm-holder"></div>
      <div class="fb-dropinfo-holder">
        <div class="fb-dropinfo">
          <div class="fb-dropinfo-line1"></div>
          <div class="fb-dropinfo-closebutton">&#x2716</div>
          <div class="fb-dropinfo-line2"></div>
          <progress class="fb-dropinfo-progress" value="0" max="100"></progress>
          <div class="fb-dropinfo-line3"></div>
          <button class="fb-dropinfo-cancel">Cancel</button>
        </div>
      </div>
      <div class="fb-buttonbar">
      <div class="fb-pencilbutton fb-barbutton"></div>
      <div class="fb-locksoundbutton fb-barbutton"></div>
      <div class="fb-newfolderbutton fb-barbutton"></div>
      <div class="fb-downloadbutton fb-barbutton"></div>
      <div class="fb-uploadbutton fb-barbutton"></div>
      <div class="fb-trashbutton fb-barbutton"></div>
      </div>
      <canvas class="fb-dragimage"></canvas>
      <div class="fb-treediv">
        <div class="fb-treerootpath"></div>
        <ul class="fb-tree"></ul>
      </div>
      <div class="fb-splitter"></div>
      <div class="fb-splitterflag"></div>
      <div class="fb-filesdiv">
        <div class="fb-dirpath"></div>
        <div class="fb-fileslist"></div>
      </div>
    `;

    this.dragStart = this.dragStart.bind(this);
    this.dragEnd = this.dragEnd.bind(this);
    this.allowDrop = this.allowDrop.bind(this);
    this.dragEnter = this.dragEnter.bind(this);
    this.drop = this.drop.bind(this);
    this.readPaths = this.readPaths.bind(this);
    this.dirClicked = this.dirClicked.bind(this);
    this.fileClicked = this.fileClicked.bind(this);
    this.listPointerDown = this.listPointerDown.bind(this);
    this.splitterPointerDown = this.splitterPointerDown.bind(this);
    this.splitterPointerMove = this.splitterPointerMove.bind(this);
    this.splitterPointerUp = this.splitterPointerUp.bind(this);
    this.showContextMenu = this.showContextMenu.bind(this);
    this.hideContextMenu = this.hideContextMenu.bind(this);

    const splitter = this.anchor_elem.querySelector(".fb-splitter");
    splitter.onpointerdown = (e) => { this.splitterPointerDown(e); };
    const splitterflag = this.anchor_elem.querySelector(".fb-splitterflag");
    splitterflag.onpointerdown = (e) => { this.splitterPointerDown(e); };
    this.splitterSetFlagPos();

    const fileList = this.anchor_elem.querySelector('.fb-fileslist');
    fileList.onpointerdown = (e) => { this.listPointerDown(e); };
    fileList.oncontextmenu = (e) => { this.showContextMenu(e); };
    fileList.addEventListener("dragstart", this.dragStart);
    this.anchor_elem.addEventListener("dragend", this.dragEnd);

    const rootlabel = this.anchor_elem.querySelector(".fb-treerootpath");
    if (this.drives.length > 1) {
      var rootlabeldropdown = '<select name="drive" class="fb-driveselector">';
      for (var i = 0; i < this.drives.length; i++) {
        rootlabeldropdown += `<option value="${i}">${this.drives[i].label}</option>`
      }
      rootlabeldropdown += '</select><span class="fb-diskinfo-outer"><div class="fb-diskinfo-inner"><span class="fb-diskinfo"></span></div></span>'
      rootlabel.innerHTML = rootlabeldropdown;
      const selector = this.anchor_elem.querySelector(".fb-driveselector");
      selector.onchange = (e) => {
        this.curdrive = selector.value;
        this.root_path = this.drives[this.curdrive].path;
        this.root_label = this.drives[this.curdrive].label;
        this.ls(".", false);
        this.ls(".", true);
        this.updateButtonBar();
      };
    } else {
      rootlabel.innerHTML = `<span class="fb-treerootpathsinglelabel">${this.drives[0].label}</span><span class="fb-diskinfo-outer"><div class="fb-diskinfo-inner"><span class="fb-diskinfo"></span></div></span>`;
    }

    this.buttonbar = this.anchor_elem.querySelector(".fb-buttonbar");
    this.buttonbar.querySelector(".fb-uploadbutton").onclick = (e) => { this.pickFile(); };
    this.buttonbar.querySelector(".fb-downloadbutton").onclick = (e) => { this.downloadSelection(); };
    this.buttonbar.querySelector(".fb-newfolderbutton").onclick = (e) => { this.newFolder(); };
    this.buttonbar.querySelector(".fb-trashbutton").onclick = (e) => { this.deleteItems(this.selection()); };
    this.buttonbar.querySelector(".fb-pencilbutton").onclick = (e) => {
      const item = this.selection()[0];
      item.scrollIntoView({block: "nearest"});
      this.renameItem(item);
    };
    this.buttonbar.querySelector(".fb-locksoundbutton").onclick = (e) => {
      const item = this.selection()[0];
      this.makeLockChime(item);
    };

    this.ls(".", true);
    this.updateButtonBar();
  }

  log(msg) {
    if (this.DEBUG) {
      console.log(msg);
    }
  }

  async refreshLists(callback) {
    var tree = this.anchor_elem.querySelector(".fb-tree");
    var openPaths = [];
    tree.querySelectorAll("details[open] > summary").forEach((s) => { openPaths.push(s.dataset.fullpath); });
    await this.ls(".", false);
    openPaths.forEach((path) => {
      var detail = tree.querySelector(`details:has(summary[data-fullpath="${path}"])`);
      if (detail != null) {
        detail.open = true;
      }
    });
    await this.ls(this.current_path, true);
    if (callback) {
      callback();
    }
  }

  newFolder() {
    var fl = this.anchor_elem.querySelector(".fb-fileslist");
    for (var i = 1; i < 100; i++) {
      var str = `${this.current_path == "." ? "" : this.current_path + "/"}New folder${i == 1 ? '' : " (" + i + ")"}`;
      this.log(str);
      var item = fl.querySelector(`[data-fullpath="${this.stringEncode(str)}"]`);
      if (item == null) {
        this.readfile(
          {url:`cgi-bin/mkdir.sh?${encodeURIComponent(this.root_path)}&${encodeURIComponent(str)}`,
            callback:(response, data) => {
              this.refreshLists(() => {
                var item = fl.querySelector(`[data-fullpath="${this.stringEncode(str)}"]`);
                if (item) {
                  item.scrollIntoView({block: "nearest"});
                  this.selectItem(item);
                  this.renameItem(item);
                }
              });
            }
          });
        return;
      }
    }
    this.log("could not find empty new folder name");
  }

  deleteItems(items) {
    var pathsList = "";
    items.forEach((item) => {
      const fullpath = this.stringDecode(item.dataset.fullpath)
      pathsList += "&";
      pathsList += encodeURIComponent(fullpath);
    });
    this.readfile(
      {url:`cgi-bin/rm.sh?${this.root_path}${pathsList}`,
      callback:(response, data) => {
        this.log(response);
        this.refreshLists();
      }
      });
  }

  deleteItem(item) {
    this.deleteItems([item]);
  }

  downloadSelection() {
    const url = this.downloadURLForSelection().substr(1);
    const name = url.substr(0, url.indexOf(":"));
    const url2 = url.substr(url.indexOf(":") + 1);
    this.log(`name: ${name}, url: ${url2}`);
    
    var elem = document.createElement('a');
    elem.setAttribute('href', url2);
    elem.setAttribute('download', name);
    elem.style.display = 'none';
    document.body.appendChild(elem);
    elem.click();
    document.body.removeChild(elem);
  }

  selectItemContent(item) {
    var range,selection;
    if(document.createRange)
    {
        range = document.createRange();
        range.selectNodeContents(item);
        selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    }
  }

  applyRename(item) {
    const fullpath = this.stringDecode(item.dataset.fullpath);
    const idx = fullpath.lastIndexOf("/");
    const oldname = fullpath.substr(idx + 1);
    var newname = item.textContent;
    this.log('renaming "' + oldname + '" to "' + newname + '"');
    this.readfile(
      {url:`cgi-bin/mv.sh?${this.root_path}/${this.current_path}&${encodeURIComponent(oldname)}&${encodeURIComponent(newname)}`,
      callback:(response, data) => {
        this.log(response);
        this.refreshLists();
      }
      });
  }

  stopEditingItem(item, oldValue) {
    // clear onblur first because setting contentEditable to false immediately triggers a blur
    item.onblur = undefined;
    item.contentEditable = false;
    item.onkeydown = undefined;
    item.oncontextmenu = undefined;
    if (item.textContent != oldValue) {
      this.applyRename(item);
    }
  }

  renameItem(item) {
    const oldValue = item.textContent;
    item.contentEditable = true;
    this.selectItemContent(item);
    item.onkeydown = (e) => {
      if (e.key == 'Enter') {
        this.stopEditingItem(item, oldValue);
      } else if (e.key == 'Escape') {
        item.textContent = oldValue;
        this.stopEditingItem(item, oldValue);
      }
    };
    item.onblur = (e) => {
      this.stopEditingItem(item, oldValue);
    };
    // Tapping on the selected text to position the cursor
    // on mobile results in a context menu event, so intercept
    // that while editing.
    item.oncontextmenu = (e) => { e.stopPropagation(); };
    item.focus();
  }

  makeLockChime(item) {
    // copy the selected item
     this.readfile(
      {url:`cgi-bin/cp.sh?${this.root_path}&${encodeURIComponent(item.dataset.fullpath)}&LockChime.wav`,
      callback:(response, data) => {
        this.log(response);
        this.refreshLists();
      }
      });
  }

  showButton(name, show) {
    if (show) {
      this.buttonbar.querySelector(name).classList.add("fb-visiblebarbutton");
    } else {
      this.buttonbar.querySelector(name).classList.remove("fb-visiblebarbutton");
    }
  }

  updateButtonBar() {
    const numsel = this.numSelected();
    const enabled = this.valid;
    this.showButton(".fb-trashbutton", enabled && numsel > 0);
    this.showButton(".fb-pencilbutton", enabled && numsel == 1);
    this.showButton(".fb-uploadbutton", enabled && numsel == 0);
    this.showButton(".fb-downloadbutton", enabled && numsel > 0);
    this.showButton(".fb-newfolderbutton", enabled && numsel == 0);
    this.showButton(".fb-locksoundbutton", enabled && numsel == 1 && this.isPotentialLockChime(this.selection()[0]));
    if (this.buttonbar.querySelector(".fb-visiblebarbutton") == null) {
      this.buttonbar.style.display = "none";
    } else {
      this.buttonbar.style.display = "block";
    }
  }

  eventCoordinates(e) {
    if (e.targetTouches && e.targetTouches.length > 1) {
      const t = e.targetTouches[0]
      return [t.clientX, t.clientY];
    }
    return [e.x, e.y];
  }

  makeMultiSelectContextMenu(event) {
    new ContextMenu(this.anchor_elem,
      [
        new ContextMenuItem("Download selected items",
          () => {
            this.downloadSelection();
          }, null),
        new ContextMenuItem("Delete selected items",
          () => {
            this.deleteItems(this.selection());
          }, null)

      ]).show(...this.eventCoordinates(event));
  }

  makeListContextMenu(event) {
    new ContextMenu(this.anchor_elem,
      [
        new ContextMenuItem("New folder", () => { this.newFolder(); }, null)
      ]).show(...this.eventCoordinates(event));
  }

  makeDirContextMenu(event) {
    const e = event;
    new ContextMenu(this.anchor_elem,
      [
        new ContextMenuItem("Rename", () => { this.renameItem(e.target); }, null),
        new ContextMenuItem("Download", () => { this.downloadSelection(); }, null),
        new ContextMenuItem("Delete", () => { this.deleteItem(e.target); }, null)
      ]).show(...this.eventCoordinates(event));
  }

  makeFileContextMenu(event) {
    const filename = event.target.innerText;
    const e = event;
    new ContextMenu(this.anchor_elem,
      [
        ...this.isPotentialLockChime(event.target) ? [ new ContextMenuItem("Use as lock sound", () => { this.makeLockChime(e.target); }, null) ] : [],
        new ContextMenuItem("Rename", () => { this.renameItem(e.target); }, null),
        new ContextMenuItem("Download", () => { this.downloadSelection(); }, null),
        new ContextMenuItem("Delete", () => { this.deleteItem(e.target); }, null)
      ]).show(...this.eventCoordinates(event));
  }

  hideContextMenu() {
    var contextmenu = this.anchor_elem.querySelector(".cm-holder");
    if (contextmenu == null) {
      return;
    }
    contextmenu.style.visibility = "hidden";
  }

  showContextMenu(event) {
    this.log("context menu");
    if (!this.valid || event.ctrlKey) {
      this.hideContextMenu();
      return;
    }
    if (event.pointerType == "touch") {
      // long press triggered context menu
      this.log("touch context menu");
      event.preventDefault();
      return;
    }
    var target = event.target;
    try {
      if (target.classList.contains("fb-fileslist")) {
        this.unselectAll();
        this.makeListContextMenu(event);
      } else if (this.numSelected() > 1 && this.isSelected(target)) {
        this.makeMultiSelectContextMenu(event);
      } else {
        this.unselectAll();
        this.selectItem(target);
        if (target.classList.contains("fb-direntry")) {
          this.makeDirContextMenu(event);
        } else if (target.classList.contains("fb-fileentry")) {
          this.makeFileContextMenu(event);
        }
      }
      event.preventDefault();
    } catch (e) {
      this.log("error creating context menu");
      this.log(e);
    }
  }

  splitterSetFlagPos() {
    const splitter = this.anchor_elem.querySelector(".fb-splitter");
    const splitterflag = this.anchor_elem.querySelector(".fb-splitterflag");
    splitterflag.style.left = (splitter.getBoundingClientRect().x - 
      splitterflag.getBoundingClientRect().width + 1) + "px";
  }

  splitterPointerMove(event) {
    const treediv = this.anchor_elem.querySelector(".fb-splitter").previousElementSibling;
    const treedivrect = treediv.getBoundingClientRect();
    const newwidth = event.clientX + this.splitter_clickoffset - treedivrect.x;
    treediv.style.width = `${newwidth}px`;
    this.splitterSetFlagPos();
  }

  splitterPointerUp(event) {
    const splitter = event.target;
    splitter.removeEventListener("pointermove", this.splitterPointerMove);
    splitter.removeEventListener("pointerup", this.splitterPointerUp);
    splitter.releasePointerCapture(event.pointerId);
    this.splitter_active = false;
  }

  splitterPointerDown(event) {
    var splitter = event.target;
    splitter.addEventListener("pointermove", this.splitterPointerMove);
    splitter.addEventListener("pointerup", this.splitterPointerUp);
    splitter.setPointerCapture(event.pointerId);
    const treediv = this.anchor_elem.querySelector(".fb-splitter").previousElementSibling;
    const treedivrect = treediv.getBoundingClientRect();
    this.splitter_clickoffset = treedivrect.x + treedivrect.width - event.clientX;
    this.splitter_active = true;
  }

  intersects(r1, r2) {
    return !(r1.x + r1.width  < r2.x ||
             r2.x + r2.width  < r1.x ||
             r1.y + r1.height < r2.y ||
             r2.y + r2.height < r1.y);
  }

  updateSelection(selectRectElem) {
    const select = selectRectElem.getBoundingClientRect();

    const {x, y, height, width} = select;

    selectRectElem.parentElement.querySelectorAll(".fb-direntry, .fb-fileentry").forEach((item) => {
      if (this.intersects({x: x + window.scrollX, y: y + window.scrollY, height, width}, item.getBoundingClientRect())){
        item.classList.add("fb-selected");
      } else {
        item.classList.remove("fb-selected");
      }
    } );
    this.updateButtonBar();
  }

  unselectAll() {
    this.selection().forEach((e) => { e.classList.remove("fb-selected");});
    this.updateButtonBar();
  }

  isSelected(elem) {
    return elem.classList.contains("fb-selected")
  }

  selectItem(elem) {
    elem.classList.add("fb-selected");
    this.updateButtonBar();
  }

  selection() {
    var fl = this.anchor_elem.querySelector(".fb-fileslist");
    return fl.querySelectorAll(".fb-selected");
  }

  numSelected() {
    return this.selection().length;
  }

  async createSelectionRectangle(thiz, event) {
    const fileList = event.target;
    const x = event.offsetX + fileList.scrollLeft;
    const y = event.offsetY + fileList.scrollTop;

    const div = document.createElement("div");
    div.style.width = "0";
    div.style.height = "0";
    div.style.left = x + "px";
    div.style.top = y + "px";
    div.classList.add("fb-selection-rect");
    fileList.append(div);

    function resize(event) {
      thiz.log("resize");
      if (event.buttons == 0) {
        cancelSelectionRectangle(event);
        return;
      }
      if (event.target != fileList) {
        return;
      }

      const rect = fileList.getBoundingClientRect();
      const offX = (event.touches ? event.touches[0].clientX - rect.left :
                    event.offsetX) + fileList.scrollLeft;
      const offY = (event.touches ? event.touches[0].clientY - rect.top :
                    event.offsetY) + fileList.scrollTop;
      const maxX = fileList.clientWidth + fileList.scrollLeft;
      const maxY = fileList.clientHeight + fileList.scrollTop;
      const curX = offX > maxX ? maxX : offX;
      const curY = offY > maxY ? maxY : offY;
      const dX = curX - x;
      const dY = curY - y;
      div.style.left = dX < 0 ? x + dX + "px" : x + "px";
      div.style.top = dY < 0 ? y + dY + "px" : y + "px";
      div.style.width = Math.abs(dX) + "px";
      div.style.height = Math.abs(dY) + "px";
      thiz.updateSelection(div);
      if (event.cancelable) {
        event.preventDefault();
      }
    }

    if (! event.ctrlKey) {
      this.unselectAll();
    }

    function cancelSelectionRectangle(event) {
      thiz.log("cancelSelectionRectangle");
      event.target.removeEventListener("pointermove", resize);
      try {
        fileList.releasePointerCapture(event.pointerId);
      } catch(error) {
        thiz.log("release error");
      }
      fileList.removeEventListener("touchmove", resize);
      fileList.removeEventListener("touchend", pointerup);
      fileList.removeEventListener("pointermove", resize);
      fileList.removeEventListener("pointerup", pointerup);
      fileList.removeEventListener("cancelselectionrect", cancelSelectionRectangle);
      div.remove();
    }

    function pointerup(event) {
      thiz.log("pointerup");
      cancelSelectionRectangle(event);
    }

    fileList.setPointerCapture(event.pointerId);
    if (event.pointerType == "touch") {
      fileList.addEventListener("touchmove", resize);
      fileList.addEventListener("touchend", pointerup);
    } else {
      fileList.addEventListener("pointermove", resize);
      fileList.addEventListener("pointerup", pointerup);
    }
    fileList.addEventListener("cancelselectionrect", cancelSelectionRectangle);
  }

  listPointerDown(event) {
    /* only respond to left mouse button */
    if (!this.valid || event.button != 0) {
      event.preventDefault();
      return;
    }
    event.target.dispatchEvent(
      new Event("cancelselectionrect", {
        bubbles: true,
        cancelable: true,
        composed: false
      })
    );
    this.createSelectionRectangle(this, event);
  }

  dirClicked(event, path) {
    var expanderclicked = (event && event.offsetX < 0);
    this.ls(path, !expanderclicked);
  }

  isPlayable(filename) {
    const lower = filename.toLowerCase();
    for (const ext of [".mp3", ".m4a", ".flac", ".ogg", ".wav"]) {
      if (lower.endsWith(ext)) {
        return true;
      }
    }
    return false;
  }

  isPotentialLockChime(item) {
    const lower = item.dataset.fullpath.toLowerCase();
    if (lower == "lockchime.wav") {
      return false;
    }
    if (!lower.endsWith(".wav")) {
      return false;
    }
    if (item.dataset.filesize > 1024 * 1024) {
      return false;
    }
    return true;
  }

  fileClicked(event, path) {
    this.log(`clicked: ${path}`);

    var displaypath =  path;
    if (this.isPlayable(path)) {
      const div = document.createElement("div");
      div.style.position = "absolute";
      div.style.width = "100%";
      div.style.height = "100%";
      div.style.left = "0";
      div.style.top = "0";
      div.style.background = "#0008";
      div.onclick = (e) => { if (e.target === div) div.remove(); };
      document.firstElementChild.append(div);
      div.innerHTML = `<div class="fb-player"><div class="fb-playertitle">${displaypath}</div><audio autoplay controls src="${encodeURIComponent(this.root_path + "/" + path)}"></div>`;
      div.querySelector(".fb-playertitle").scrollLeft=1000;
    }
  }

  // From https://developer.mozilla.org/en-US/docs/Glossary/Base64#the_unicode_problem.
  base64ToBytes(base64) {
    const binString = atob(base64);
    return Uint8Array.from(binString, (m) => m.codePointAt(0));
  }

  // From https://developer.mozilla.org/en-US/docs/Glossary/Base64#the_unicode_problem.
  bytesToBase64(bytes) {
    const binString = String.fromCodePoint(...bytes);
    return btoa(binString);
  }

  stringEncode(str) {
    return str; // this.bytesToBase64((new TextEncoder()).encode(str));
  }

  stringDecode(encstr) {
    return encstr; // new TextDecoder().decode(this.base64ToBytes(encstr));
  }

  addCommonDragHooks(item) {
    item.ondragover = this.allowDrop;
    item.ondragenter = this.dragEnter;
    item.ondragleave = this.dragLeave;
    item.ondrop = this.drop;
  }

  createTreeItem(label, fullPath) {
    var li = document.createElement("li");
    li.innerHTML = '<details>' +
       '<summary class="fb-treedirentry" data-fullpath="' + this.stringEncode(fullPath) + '" draggable=true>' + label + '</summary>' +
       '<ul></ul></details>';
    const s = li.querySelector("summary");
    s.onclick = (e) => { this.dirClicked(e, this.stringDecode(e.target.dataset.fullpath)); };
    s.ondragstart = this.dragStart;
    const u = li.querySelector("ul");
    u.dataset.fullpath = fullPath;
    this.addCommonDragHooks(u);
    return li;
  }

  addDir(root, path) {
    var pathParts = path.split("/");
    var pathSoFar = null;
    for (var i = 0; i < pathParts.length; i++) {
      if (pathSoFar) {
        pathSoFar += "/" + pathParts[i];
      } else {
        pathSoFar = pathParts[i];
      }
      var node = root.querySelector(`[data-fullpath="${this.stringEncode(pathSoFar)}"]`);
      if (node == null) {
        /* level 'i' doesn't exist yet, add it */
        var newPath = this.createTreeItem(pathParts[i], pathSoFar);
        root.appendChild(newPath);
        root = newPath.querySelector("ul");
      } else {
        /* level 'i' already exists, check the next level */
        root = node.nextElementSibling;
      }
    }
    return root;
  }

  readfile({url, callback, callbackarg}) {
    var request = new XMLHttpRequest();
    request.open('GET', url);
    request.onreadystatechange = function () {
      if (request.readyState === XMLHttpRequest.DONE) {
        if (request.status === 200) {
          var type = request.getResponseHeader('Content-Type');
          if (type.indexOf("text") !== 1) {
            if (callback != null) {
              callback(request.responseText, callbackarg);
            }
          }
        } else if (request.status > 400) {
            if (callback != null) {
              callback(null, null);
            }
        }
      }
    }
    request.send();
  }

  selectFileEntry(ev) {
    if (ev.button != 0) return;
    ev.stopPropagation();
    if (! ev.ctrlKey) {
      /* not multi-select, so deselect everything that was previously selected */
      this.unselectAll();
    }
    ev.target.classList.toggle("fb-selected");
    this.updateButtonBar();
  }

  createFileEntry(isdir, name, path, size) {
    var div = document.createElement("div");
    div.className = isdir ? "fb-direntry" : "fb-fileentry"
    div.textContent = name;
    div.draggable = true;
    if (isdir) {
      div.ondblclick = (e) => { this.dirClicked(null, path); };
      this.addCommonDragHooks(div);
      div.dataset.fullpath = this.stringEncode(path);
    } else {
      const justThePath = path.substring(0, path.lastIndexOf(":"));
      div.ondblclick = (e) => { this.fileClicked(null, justThePath); };
      div.dataset.fullpath = this.stringEncode(justThePath);
      div.dataset.filesize = path.substring(path.lastIndexOf(":") + 1);
    }
    div.onclick = (e) => { this.selectFileEntry(e); };
    div.onpointerdown = (e) => { e.stopPropagation(); };
    return div;
  }

  addFileEntry(path) {
    var isDir = path.indexOf("d:") == 0;
    path = path.substring(2);
    var lastSlash = path.lastIndexOf("/");
    var name = path.substring(lastSlash + 1);
    var lastColon = name.lastIndexOf(":");
    var size = 0;
    if (lastColon > 0) {
      size = name.substring(lastColon + 1);
      name = name.substring(0, lastColon);
    }
    var newFile = this.createFileEntry(isDir, name, path, size);
    var listDiv = this.anchor_elem.querySelector('.fb-fileslist');
    listDiv.appendChild(newFile);
  }

  setDiskStats(freebytes, totalbytes) {
    var diskinfospan = this.anchor_elem.querySelector('.fb-diskinfo');
    diskinfospan.innerText = `${this.niceNumber(freebytes)} free of ${this.niceNumber(totalbytes)}`;
  }

  /*
    switchtopath=false: only update the left-hand side tree view
    switchtopath=true: update the right-hand side
  */
  readPaths(path, paths, switchtopath) {
    this.valid = (paths != null && switchtopath != null);
    if (!this.valid) {
      var pathdiv = this.anchor_elem.querySelector(".fb-dirpath");
      pathdiv.innerText = "<< error retrieving file list >>";
    }
    paths = this.valid ? paths.trimEnd() : "";
    var root = this.anchor_elem.querySelector(".fb-tree");
    root.dataset.fullpath=".";
    this.addCommonDragHooks(root);
    if (path == "." && !switchtopath) {
      root.innerHTML = '';
    }
    var lines = paths.split('\n');
    if (! this.valid || switchtopath) {
      this.anchor_elem.querySelector('.fb-fileslist').querySelectorAll(".fb-direntry,.fb-fileentry").forEach((entry) => entry.remove());
    }
    for (var line of lines) {
      if (line.indexOf("d:") == 0 || line.indexOf("D:") == 0) {
        this.addDir(root, line.substring(2));
      }
      if (line.indexOf("s:") == 0) {
        let [freebytes, totalbytes] = line.substring(2).split(":");
        this.setDiskStats(freebytes, totalbytes);
      } else if (switchtopath && ! line.indexOf("D:") == 0) {
        this.addFileEntry(line);
      }
    }
    this.updateButtonBar();
  }

  makeOnClick(thiz, path) {
    return function() { thiz.dirClicked(null, path); };

  }

  setClickablePath(container, path) {
    var pathParts = [];
    if (!path) {
      path = ".";
    } else if (path != ".") {
      pathParts = path.split("/");
    }
    this.current_path = path;
    const fileList = this.anchor_elem.querySelector('.fb-fileslist');
    fileList.dataset.fullpath = this.stringEncode(path);
    this.addCommonDragHooks(fileList);

    container.innerHTML = "";
    var pathSoFar = null;

    var a = document.createElement("a");
    if (pathParts.length > 0) {
      a.className = "fb-crumb";
      a.onclick = this.makeOnClick(this, ".");
      this.addCommonDragHooks(a);
      a.dataset.fullpath = this.stringEncode(".");
    }
    a.innerText = '[' + this.root_label + ']';
    container.appendChild(a);

    for (var i = 0; i < pathParts.length; i++) {
      if (pathSoFar) {
        pathSoFar += "/" + pathParts[i];
      } else{
        pathSoFar = pathParts[i];
      }
      var a = document.createElement("a");
      if (i < pathParts.length - 1) {
        a.className = "fb-crumb";
        a.onclick = this.makeOnClick(this, pathSoFar);
        this.addCommonDragHooks(a);
        a.dataset.fullpath = this.stringEncode(pathSoFar);
      }
      a.innerText = pathParts[i];
      container.append("/");
      container.appendChild(a);
    }
  }

  async ls(path, switchtopath) {
    return new Promise((resolve, reject) => {

    if (switchtopath) {
      var pathdiv = this.anchor_elem.querySelector(".fb-dirpath");
      this.setClickablePath(pathdiv, path);
    }
    this.readfile({url:`cgi-bin/ls.sh?${encodeURIComponent(this.root_path)}&${encodeURIComponent(path)}`, callback:(paths,switchto) => { this.readPaths(path, paths, switchto); resolve(); }, callbackarg:switchtopath});
    });
  }

  isDropAllowedForTarget(ev) {
    var destPath = this.stringDecode(ev.target.dataset.fullpath);
    if (destPath == undefined) {
      return false;
    }
    if (ev.target.classList.contains("fb-fileentry")) {
      /* files are not drop targets */
      return false;
    }
    if (!this.dragged_path) {
      /* external files are not subject to path checks */
      return true;
    }
    var pathList = [];
    const selection = this.selection();
    if (selection.length == 0) {
      // single item from the left side tree view
      pathList.push(this.dragged_path);
    } else {
      // one or more items from the right side file/folder view
      selection.forEach((srcItem) => {
        pathList.push(this.stringDecode(srcItem.dataset.fullpath));
      });
    }
    //this.log(`${pathList.toString()} => ${destPath}`);
    for (var srcPath of pathList) {
      if (destPath.startsWith(srcPath)) {
        /* can't drop parent in child */
        return false;
      }
      const idx = srcPath.lastIndexOf("/");
      const srcDir = idx > 0 ? srcPath.substr(0, idx) : ".";
      if (srcDir == destPath) {
        //this.log(`not OK: ${srcDir} => ${destPath}`);
        return;
      }
      //this.log(`OK: ${srcPath} => ${destPath}`);
    }
    return true;
  }

  allowDrop(ev) {
    if (!this.isDropAllowedForTarget(ev)) {
      return;
    }
    ev.preventDefault();
  }

  dragEnter(ev) {
    if (this.isDropAllowedForTarget(ev)) {
      ev.target.classList.add("fb-droptarget");
    }
  }

  dragLeave(ev) {
    ev.target.classList.remove("fb-droptarget");
  }

  hasExternalFiles(ev) {
    this.log(`${ev.dataTransfer.items.length} items dropped`);
    this.log(ev.dataTransfer.items.length);
    this.log(...ev.dataTransfer.items);
    this.log(ev.dataTransfer);
    this.log(ev);
    if (ev.dataTransfer.items.length > 0) {
      return true;
    }
    return false;
  }

  handleInternalDrop(ev) {
    const selection = this.selection();
    var pathList = [];
    if (selection.length == 0) {
      pathList.push(this.dragged_path);
    } else {
      selection.forEach((srcItem) => {
        pathList.push(this.stringDecode(srcItem.dataset.fullpath));
      });
    }
    var pathString = "";
    pathList.forEach((path) => {
      pathString += `&${encodeURIComponent(path)}`;
    });
    this.log(`${pathList} => ${this.stringDecode(ev.target.dataset.fullpath)}`);
    this.readfile(
      {url:`cgi-bin/mv.sh?${this.root_path}${pathString}&${this.stringDecode(ev.target.dataset.fullpath)}`,
      callback:(response, data) => {
        this.log(response);
        this.refreshLists();
      }
      });

  }

  async cancelDrop() {
    if (!this.cancelUpload) {
      this.cancelUpload = true;
      const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));
      while (this.uploading) {
        await sleep(50);
      }
    }
    this.hideDropInfo();
  }

  showDropInfo() {
    var di = this.anchor_elem.querySelector(".fb-dropinfo-holder");
    di.style.visibility = "visible";
    var cb = this.anchor_elem.querySelector(".fb-dropinfo-closebutton");
    cb.onmousedown = (e) => { this.cancelDrop(); };
    var cb = this.anchor_elem.querySelector(".fb-dropinfo-cancel");
    cb.onclick = (e) => { this.cancelDrop(); };
    var l1 = this.anchor_elem.querySelector(".fb-dropinfo-line1");
    l1.innerText = "Building file list...";
    l1.style.visibility="inherit";
    var p = this.anchor_elem.querySelector(".fb-dropinfo-progress");
    p.style.visibility="hidden";
  }

  niceNumber(totalsize) {
    var str = "";
    if (totalsize < 100000) {
      str += `${totalsize} bytes`
    } else if (totalsize < 2000000) {
      str += `${(totalsize / 1024).toFixed(0)} KB`
    } else if (totalsize < 1100000000) {
      str += `${(totalsize / (1024 * 1024)).toFixed(0)} MB`
    } else {
      str += `${(totalsize / (1024 * 1024 * 1024)).toFixed(2)} GB`
    }
    return str;
  }

  updateDropInfo(numfiles, totalsize) {
    var l2 = this.anchor_elem.querySelector(".fb-dropinfo-line2");
    var str = `${numfiles} file`;
    if (numfiles != 1) {
      str += "s";
    }
    str += ", " + this.niceNumber(totalsize);
    l2.innerText = str;

  }

  hideDropInfo() {
    var di = this.anchor_elem.querySelector(".fb-dropinfo-holder");
    di.style.visibility = "hidden";
    this.refreshLists();
  }

  async getFilePromise(entry) {
    try {
      if (entry instanceof File) {
        return entry;
      }
      return await new Promise((resolve, reject) => {
        entry.file(resolve, reject);
      });
    } catch (err) {
      this.log(err);
    }
  }

  async readEntriesPromise(reader) {
    try {
      return await new Promise((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });
    } catch (err) {
      this.log(err);
    }
  }

  async readAllDirectoryEntries(reader) {
    var entries = [];
    var readEntries = await this.readEntriesPromise(reader);
    while (readEntries.length > 0) {
      entries.push(...readEntries);
      readEntries = await this.readEntriesPromise(reader);
    }
    return entries;
  }

  async handleExternalDrop(targetpath, datatransferitems, files) {
    this.cancelUpload = false;
    this.uploading = true;
    var totalBytes = 0;
    var fileList = [];
    var queue = [];
    if (datatransferitems) {
      // Use DataTransferItemList interface to access the file(s)
      [...datatransferitems].forEach((item, i) => {
        var entry = item.webkitGetAsEntry();
        this.log(entry);
        if (entry != null) {
          queue.push(entry);
        }
      });
    } else if (files) {
      queue.push(...files);
    }

    while (queue.length > 0) {
      if (this.cancelUpload) {
        this.uploading = false;
        return;
      }
      //this.log(`processing... (${fileList.length})`);
      var entry = queue.shift();
      if (entry.isDirectory) {
        queue.push(...await this.readAllDirectoryEntries(entry.createReader()));
      } else {
        fileList.push(entry);
        if (fileList.length == 1) {
          this.showDropInfo();
        }
        var file = await this.getFilePromise(entry);
        totalBytes += file.size;
        this.updateDropInfo(fileList.length, totalBytes);
      }
    }
    this.log(`total size: ${totalBytes}`);
    var l1 = this.anchor_elem.querySelector(".fb-dropinfo-line1");
    l1.numitems = fileList.length;

    var p = this.anchor_elem.querySelector(".fb-dropinfo-progress");
    p.style.visibility="inherit";
    p.max = totalBytes;
    p.value = 0;
    this.uploadFiles(targetpath, fileList);
  }

  pickFile() {
    var input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = (e) => {
      if (input.files.length > 0) {
        this.handleExternalDrop(this.current_path, null, input.files);
      }
    };
    input.click();
  }

  uploadFiles(destpath, fileList) {
    var lastLoaded = 0;
    if (fileList.length > 0 && ! this.cancelUpload) {
      var f = fileList.shift();
      var l1 = this.anchor_elem.querySelector(".fb-dropinfo-line1");
      l1.innerText = `File ${l1.numitems - fileList.length} / ${l1.numitems}`;
      var l2 = this.anchor_elem.querySelector(".fb-dropinfo-line2");
      l2.innerText = f.name;
      this.uploadFile(destpath, f,
        (status) => {
        // completion function
        if (status === 200) {
          this.uploadFiles(destpath, fileList);
        } else {
          this.log(`status: ${status}`);
          this.uploading = false;
        }
      },
      (e, request) => {
        // progress function
        const p = this.anchor_elem.querySelector(".fb-dropinfo-progress");
        p.value += (e.loaded - lastLoaded);
        const size1 = this.niceNumber(p.value);
        const size2 = this.niceNumber(p.max);
        const s = `${size1} / ${size2}`;
        const l3 = this.anchor_elem.querySelector(".fb-dropinfo-line3");
        if (l3.innerText != s) {
          l3.innerText = s;
        }
        lastLoaded = e.loaded;
        if (this.cancelUpload) {
          this.log("cancelling upload");
          request.abort();
        }
      });
    } else {
      this.hideDropInfo();
    }
  }

  async uploadFile(destpath, entry, completionCallback, progressCallback) {
    var sent = 0;
    var file = await this.getFilePromise(entry);
    var relpath = (entry instanceof File) ? file.name : entry.fullPath.substr(1);

    const request = new XMLHttpRequest();
    request.open("POST", `cgi-bin/upload.sh?${encodeURIComponent(this.root_path + "/" + destpath)}&${encodeURIComponent(relpath)}`);
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.onreadystatechange = () => {
      // Call a function when the state changes.
      if (request.readyState === XMLHttpRequest.DONE) {
          completionCallback(request.status);
      }
    };
    request.upload.onprogress = (e) => {
      progressCallback(e, request);
    };
    this.log(`uploading with progress ${file.name}`);

    request.send(file);
  }

  dragColor(counter) {
    if (counter > 4) {
      return "#00000000";
    }
    return "#000000" + ["ff", "cc", "99", "66", "33"][counter];
  }

  createDragImage(selection) {
    var img = this.anchor_elem.querySelector(".fb-dragimage");
    var ctx = img.getContext("2d");
    ctx.font = "16px Arial";
    ctx.clearRect(0, 0, 300, 150);
    var counter = 0;
    for (var item of selection) {
      ctx.fillStyle = this.dragColor(counter);
      ctx.fillText(item.innerText, 20 + counter * 4, 32 + counter * 6);
      counter += 1;
      if (counter > 4) {
        break;
      }
    };
    if (selection.length > 1) {
      const textwidth = ctx.measureText(selection.length);
      ctx.fillStyle = "#ff0000";
      ctx.beginPath();
      ctx.roundRect(0, 0, textwidth.width + 8, 20, [10]);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.fillText(selection.length, 4, 16);
    }
    return img;
  }

  drop(ev) {
    this.log(ev);
    ev.preventDefault();
    ev.target.classList.remove("fb-droptarget");
    if (this.dragged_path == ev.dataTransfer.getData("text/plain")) {
      this.handleInternalDrop(ev);
      return;
    }
    if (this.hasExternalFiles(ev)) {
      this.handleExternalDrop(this.stringDecode(ev.target.dataset.fullpath), ev.dataTransfer.items, null);
      return;
    }
    this.log("internal path inconsistency");
    this.dragged_path = undefined;
  }

  dragStart(ev) {
    /* pointer capture on the splitter element doesn't seem to
       prevent drag&drop being initiated on the tree view, so
       check here if the splitter is being dragged and cancel
       drag&drop if so. */
    if (this.splitter_active) {
      ev.preventDefault();
      return;
    }
    /* sometimes the browser will initiate a drag on filelist,
       even though its draggable attribute is not set. Check
       specifically if the thing being dragged is actually
       draggable.
    */
    if (!ev.target.draggable) {
      ev.preventDefault();
      return;
    }
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.dropEffect = "move";

    const leftSideDrag = ev.target.classList.contains("fb-treedirentry");

    if (leftSideDrag) {
      /* dragging from the left side tree view, so deselect everything on the right side */
      this.unselectAll();
    } else if (!this.isSelected(ev.target)) {
      /* the item being dragged was not selected, so deselect everything else and then select it */
      this.unselectAll();
      this.selectItem(ev.target);
    }
    if (ev.target.classList.contains("fb-fileentry") || ev.target.classList.contains("fb-direntry")) {
      ev.dataTransfer.setDragImage(this.createDragImage(this.selection()), 22, 18);
    }
    const num = this.numSelected();
    if (num > 1) {
      this.log("multi-drag");
    } else if (num == 1) {
      this.log("single-drag");
    } else if (leftSideDrag) {
      this.log("single left side drag");
    } else {
      this.log("no-drag");
    }

    /* DragEvent.dataTransfer's data is only available in ondrop, but will be
       empty in ondragover/enter/leave. Since the source path is needed during
       drag to determine whether something can actually be dropped, store it
       elsewhere */
    this.dragged_path = this.stringDecode(ev.target.dataset.fullpath);
    ev.dataTransfer.setData("text/plain", this.dragged_path);
    if (ev.target.classList.contains("fb-treedirentry")) {
      ev.dataTransfer.setData("DownloadURL", this.downloadURLForTreeItem(ev.target));
    } else {
      ev.dataTransfer.setData("DownloadURL", this.downloadURLForSelection());
    }
  }

  dragEnd(ev) {
    this.dragged_path = undefined;
  }

  downloadURLForTreeItem(item) {
    const downloadName = item.innerText + ".zip";
    const fullpath = this.stringDecode(item.dataset.fullpath);
    const idx = fullpath.lastIndexOf("/") + 1;
    const root = encodeURIComponent(`${this.root_path}${idx?"/":""}${fullpath.substr(0,idx)}`);
    const relpath = encodeURIComponent(fullpath.substr(idx));
    this.log(`:${downloadName}:${document.location.href}cgi-bin/downloadzip.sh?${root}&${relpath}`);
    return `:${downloadName}:${document.location.href}cgi-bin/downloadzip.sh?${root}&${relpath}`;
  }

  downloadURLForSelection() {
    var filesOnly = true;
    var downloadName = "TeslaUSB-download";
    const selection = this.selection();
    selection.forEach((e) => { if (e.classList.contains("fb-direntry")) filesOnly = false;});

    if (this.numSelected() == 1) {
      const selected = selection[0];
      downloadName = selected.innerText;
      if (filesOnly) {
        const fullpath = encodeURIComponent(this.stringDecode(selected.dataset.fullpath));
        const root = encodeURIComponent(this.root_path);
        return `:${downloadName}:${document.location.href}cgi-bin/download.sh?${root}&${fullpath}`;
      }
    }

    // the user is dragging multiple entries, or a single directory-entry.
    downloadName += ".zip";
    var pathsList = encodeURIComponent(`${this.root_path}`);
    if (this.current_path != ".") {
      pathsList += encodeURIComponent(`/${this.current_path}`);
    }
    selection.forEach((e) => {
      const fullpath = this.stringDecode(e.dataset.fullpath)
      const relpath = this.current_path != "." ?  fullpath.substr(this.current_path.length + 1) : fullpath;
      pathsList += "&";
      pathsList += encodeURIComponent(relpath);
    });
    return `:${downloadName}:${document.location.href}cgi-bin/downloadzip.sh?${pathsList}`;
  }
}
