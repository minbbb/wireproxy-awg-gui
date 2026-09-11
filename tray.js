'use strict';

const { Tray, Menu, nativeImage } = require('electron');

const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA6klEQVR42s1XwQ3DIAwkc2SBvDxExuHnF+OwRybg4TfrEKWyqjRqI1MCtqX7RIE7bGxs54QGhBMQrkAYgDAC4QaEibHxt8D/TO4pA8KZNz6IihCJ18yt5B4IcwXxFcda/++pYwPxFVHsDSBcOKblYRx7LpKT9yA/i5jvBMSO5O9w3F24Mgj+m+vzQAH5IxScs2UwwrnC1RSZ8ssqBaRXxeTS2UTcIGStcn8HAUGcerUmTklp4ekkYHPSC9hJQDIhQD0E6pdQPQ3VC5FuKVZ/jEw8x+oNiYmWzERTqt6WmxhMTIxmZobTEeP5Dn3bhq2sKAOcAAAAAElFTkSuQmCC';

class TrayController {
  constructor(options) {
    this.getState = options.getState;
    this.onToggleWindow = options.onToggleWindow;
    this.onStartStop = options.onStartStop;
    this.onSetAutostart = options.onSetAutostart;
    this.onSetAutoconnect = options.onSetAutoconnect;
    this.onQuit = options.onQuit;

    const image = nativeImage.createFromDataURL(
      'data:image/png;base64,' + TRAY_ICON_BASE64
    );
    this.tray = new Tray(image);
    this.tray.on('click', () => this.onToggleWindow());
    this.sync();
  }

  sync() {
    const s = this.getState();
    this.tray.setToolTip('wireproxy-awg GUI' + (s.stateLabel ? ' - ' + s.stateLabel : ''));
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: s.windowVisible ? 'Hide window' : 'Show window', click: () => this.onToggleWindow() },
        { type: 'separator' },
        { label: s.running ? 'Stop connection' : 'Start connection', enabled: s.running || s.hasDefaultProfile, click: () => this.onStartStop() },
        { label: 'Default profile: ' + (s.defaultProfileName || 'none'), enabled: false },
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
          enabled: !!s.hasDefaultProfile,
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