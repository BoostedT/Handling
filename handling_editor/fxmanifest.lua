fx_version 'cerulean'
game 'gta5'
lua54 'yes'

name 'handling_editor'
description 'Live handling.meta editor - edit in-game, save straight to the resource file'
version '2.0.0'

ui_page 'html/index.html'

files {
    'html/index.html',
    'html/style.css',
    'html/app.js',
}

shared_script 'shared/fields.lua'
client_scripts {
    'client/main.lua',
    'client/freecam.lua',
}
-- Order matters: each file uses globals from the ones above it.
server_scripts {
    'config.lua',
    'server/store.lua',
    'server/permissions.lua',
    'server/history.lua',
    'server/presets.lua',
    'server/main.lua',
}
