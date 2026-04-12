class ContextMenuItem {
  label = undefined;
  callback = undefined;
  data = undefined;
  constructor(label, callback, data) {
    this.label = label;
    this.callback = callback;
    this.data = data;
  }
}

class ContextMenu {
  contextmenu = undefined;

  constructor(anchor, items) {
    this.contextmenuholder = anchor.querySelector(".cm-holder");
    if (this.contextmenuholder == null) {
      console.log("context menu not found");
      return undefined;
    }
    this.contextmenuholder.innerHTML = '<div class="cm-menu"></div>';
    this.contextmenupanel = this.contextmenuholder.querySelector(".cm-menu");
//    this.hide = this.hide.bind(this);
//    this.blur = this.blur.bind(this);
    items.forEach((item) => {
      var div = document.createElement("div");
      div.classList.add("cm-item");
      div.innerText = item.label;
      div.onclick = (e) => { this.hide(); if (item.callback != null) { item.callback(item.data); }};
      this.contextmenupanel.appendChild(div);
    });
  }

  show(x, y) {
    const maxY = this.contextmenuholder.clientHeight - this.contextmenupanel.clientHeight;
    if (y > maxY) {
      y = maxY;
    }
    this.contextmenupanel.style.left = x + "px";
    this.contextmenupanel.style.top = y + "px";
    this.contextmenupanel.tabIndex = 0;
    this.contextmenupanel.onkeydown = (e) => { this.keyDown(e);};
    this.contextmenuholder.onmousedown  = (e) => { this.holderClicked(e); };
    this.contextmenuholder.style.visibility = "visible";
    this.contextmenupanel.focus();
  }

  hide() {
    this.contextmenuholder.style.visibility = "hidden";
  }

  keyDown(event) {
    if (event.key == 'Escape') {
      this.hide();
    }
  }

  holderClicked(event) {
    if (event.target.classList.contains("cm-holder")) {
      this.hide();
    }
  }
}
