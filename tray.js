'use strict';

const { Tray, Menu, nativeImage } = require('electron');

const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA6klEQVR42s1XwQ3DIAwkc2SBvDxExuHnF+OwRybg4TfrEKWyqjRqI1MCtqX7RIE7bGxs54QGhBMQrkAYgDAC4QaEibHxt8D/TO4pA8KZNz6IihCJ18yt5B4IcwXxFcda/++pYwPxFVHsDSBcOKblYRx7LpKT9yA/i5jvBMSO5O9w3F24Mgj+m+vzQAH5IxScs2UwwrnC1RSZ8ssqBaRXxeTS2UTcIGStcn8HAUGcerUmTklp4ekkYHPSC9hJQDIhQD0E6pdQPQ3VC5FuKVZ/jEw8x+oNiYmWzERTqt6WmxhMTIxmZobTEeP5Dn3bhq2sKAOcAAAAAElFTkSuQmCC';

const STATUS_DOT_COLORS = {
  green: [60, 192, 66, 255],
  yellow: [45, 201, 245, 255],
  gray: [160, 160, 160, 255],
};

class TrayController {
  constructor(options) {
    this.getState = options.getState;
    this.onToggleWindow = options.onToggleWindow;
    this.onStartStop = options.onStartStop;
    this.onSetAutostart = options.onSetAutostart;
    this.onSetAutoconnect = options.onSetAutoconnect;
    this.onQuit = options.onQuit;

    let image = options.iconPath
      ? nativeImage.createFromPath(options.iconPath)
      : nativeImage.createEmpty();
    if (image.isEmpty()) {
      image = nativeImage.createFromDataURL(
        'data:image/png;base64,' + TRAY_ICON_BASE64
      );
    }
    if (process.platform === 'win32') {
      image = image.resize({ width: 32, height: 32 });
    }
    this._baseImage = image;
    this._icons = {};
    this._lastColor = null;

    this.tray = new Tray(image);
    this.tray.on('click', () => this.onToggleWindow());
    this.sync();
  }

  buildStatusIcon(color) {
    if (this._icons[color]) return this._icons[color];
    const img = this._baseImage;
    const { width, height } = img.getSize();
    const bitmap = img.toBitmap();
    const radius = 6;
    const cx = width - radius - 1;
    const cy = height - radius - 1;
    const rSq = radius * radius;
    const [b, g, r, a] = STATUS_DOT_COLORS[color];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const distSq = dx * dx + dy * dy;
        if (distSq > rSq) continue;
        const i = (y * width + x) * 4;
        const dist = Math.sqrt(distSq);
        let coverage = radius - dist + 0.5;
        if (coverage > 1) coverage = 1;
        if (coverage < 0) continue;
        const ca = Math.round(a * coverage);
        const ia = 255 - ca;
        bitmap[i] = Math.round((b * ca + bitmap[i] * ia) / 255);
        bitmap[i + 1] = Math.round((g * ca + bitmap[i + 1] * ia) / 255);
        bitmap[i + 2] = Math.round((r * ca + bitmap[i + 2] * ia) / 255);
        bitmap[i + 3] = Math.round((a * ca + bitmap[i + 3] * ia) / 255);
      }
    }
    this._icons[color] = nativeImage.createFromBitmap(bitmap, { width, height });
    return this._icons[color];
  }

  sync() {
    const s = this.getState();
    const color =
      s.state === 'connected' ? 'green' : s.state === 'degraded' ? 'yellow' : 'gray';
    if (color !== this._lastColor) {
      this.tray.setImage(this.buildStatusIcon(color));
      this._lastColor = color;
    }
    this.tray.setToolTip('wireproxy-awg GUI' + (s.stateLabel ? ' - ' + s.stateLabel : ''));
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: s.windowVisible ? 'Hide window' : 'Show window', click: () => this.onToggleWindow() },
        { type: 'separator' },
        { label: s.running ? 'Stop connection' : 'Start connection', enabled: s.running || s.hasDefaultTarget, click: () => this.onStartStop() },
        { label: 'Default target: ' + (s.defaultTargetName || 'none'), enabled: false },
        { type: 'separator' },
        {
          label: 'Launch on Windows login',
          type: 'checkbox',
          checked: s.autostart,
          click: () => this.onSetAutostart(!s.autostart),
        },
        {
          label: 'Auto-connect on launch',
          type: 'checkbox',
          checked: s.autoconnect,
          enabled: !!s.hasDefaultTarget,
          click: () => this.onSetAutoconnect(!s.autoconnect),
        },
        { type: 'separator' },
        { label: 'Quit', click: () => this.onQuit() },
      ])
    );
  }

  destroy() {
    this.tray.destroy();
  }
}

module.exports = TrayController;