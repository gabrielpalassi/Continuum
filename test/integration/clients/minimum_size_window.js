// SPDX-License-Identifier: GPL-3.0-or-later

import Gtk from 'gi://Gtk?version=4.0';

const application = new Gtk.Application({
    application_id: 'org.gnome.Shell.Extensions.Continuum.MinimumSizeTest',
});

application.connect('activate', () => {
    const content = new Gtk.Box();
    content.set_size_request(600, 400);
    const window = new Gtk.ApplicationWindow({
        application,
        title: 'Continuum minimum-size test',
        default_width: 700,
        default_height: 500,
        child: content,
    });
    window.present();
});

application.run(['continuum-minimum-size-test']);
