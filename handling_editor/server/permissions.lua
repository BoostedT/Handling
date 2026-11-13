-- Role-based access keyed on Discord user IDs (see config.lua).
--
-- A player's role is the highest-ranked of:
--   * Config.Users[their Discord ID]        (config.lua, can't be changed in-game)
--   * the in-game list                      (Access tab / `heperm add`, kept in KVP)
--   * any ACE in Config.AceRoles, or handling_editor.role.<name>
-- The server console always has every permission.

Perms = {}

local ALL_PERMS = { 'open', 'save', 'bulk', 'tools', 'freecam', 'history', 'restore', 'publish', 'lock', 'manage' }

local roles, roleList, topRank = {}, {}, 0
for _, r in ipairs(Config.Roles or {}) do
    if type(r) == 'table' and type(r.name) == 'string' then
        local set, all = {}, false
        for _, p in ipairs(r.perms or {}) do
            if p == '*' then all = true else set[p] = true end
        end
        if all then
            for _, p in ipairs(ALL_PERMS) do set[p] = true end
        end
        local role = { name = r.name, label = r.label or r.name, rank = tonumber(r.rank) or 0, set = set, all = all }
        roles[r.name] = role
        roleList[#roleList + 1] = role
        if role.rank > topRank then topRank = role.rank end
    end
end
table.sort(roleList, function(a, b) return a.rank < b.rank end)

local CONSOLE_ROLE = { name = 'console', label = 'Server console', rank = math.huge, set = {}, all = true }
for _, p in ipairs(ALL_PERMS) do CONSOLE_ROLE.set[p] = true end

-- In-game list: discordId -> { role, label, name, addedBy, addedAt }
local stored = Store.get('users', {})
if type(stored) ~= 'table' then stored = {} end

local function persist()
    Store.set('users', stored)
end

local function configEntry(discord)
    local c = discord and Config.Users and Config.Users[discord]
    if type(c) == 'string' then return { role = c } end
    if type(c) == 'table' then return c end
    return nil
end

local function validDiscord(id)
    return type(id) == 'string' and id:match('^%d+$') ~= nil and #id >= 15 and #id <= 22
end

function Perms.discordOf(src)
    src = tonumber(src)
    if not src or src <= 0 then return nil end
    local id = GetPlayerIdentifierByType and GetPlayerIdentifierByType(src, 'discord') or nil
    if not id then
        for _, v in ipairs(GetPlayerIdentifiers(src) or {}) do
            if v:sub(1, 8) == 'discord:' then id = v break end
        end
    end
    if not id then return nil end
    id = (id:gsub('^discord:', ''))
    return validDiscord(id) and id or nil
end

-- { discord, role (table or nil), via ('config' | 'in-game' | 'ace' | 'console') }
function Perms.resolve(src)
    src = tonumber(src) or -1
    if src == 0 then return { role = CONSOLE_ROLE, via = 'console' } end

    local discord = Perms.discordOf(src)
    local best, via = nil, nil
    local function consider(roleName, how)
        local r = roles[roleName]
        if r and (not best or r.rank > best.rank) then best, via = r, how end
    end

    if discord then
        local c = configEntry(discord)
        if c then consider(c.role, 'config') end
        local s = stored[discord]
        if s then consider(s.role, 'in-game') end
    end
    for ace, roleName in pairs(Config.AceRoles or {}) do
        if IsPlayerAceAllowed(src, ace) then consider(roleName, 'ace') end
    end
    for _, r in ipairs(roleList) do
        if IsPlayerAceAllowed(src, 'handling_editor.role.' .. r.name) then consider(r.name, 'ace') end
    end

    return { discord = discord, role = best, via = via }
end

function Perms.has(src, perm)
    local r = Perms.resolve(src).role
    return r ~= nil and r.set[perm] == true
end

-- Who did something, for logs and history entries.
function Perms.describe(src)
    src = tonumber(src) or 0
    if src == 0 then return { name = 'console' } end
    return { name = GetPlayerName(src) or ('player ' .. src), discord = Perms.discordOf(src) }
end

-- What the client/panel is told about its own access.
function Perms.info(src)
    local res = Perms.resolve(src)
    local set = {}
    if res.role then
        for p in pairs(res.role.set) do set[p] = true end
    end
    return {
        role = res.role and res.role.name or nil,
        roleLabel = res.role and res.role.label or nil,
        via = res.via,
        discord = res.discord,
        perms = set,
    }
end

function Perms.push(src)
    TriggerClientEvent('handling_editor:perms', src, Perms.info(src))
end

local function onlineWithDiscord(discord)
    local out = {}
    for _, id in ipairs(GetPlayers()) do
        local n = tonumber(id)
        if n and Perms.discordOf(n) == discord then out[#out + 1] = n end
    end
    return out
end

-- ---- who may change whom ---------------------------------------------------

local function actorRole(actorSrc)
    return Perms.resolve(actorSrc)
end

-- Returns nil if allowed, else the reason it isn't.
local function editBlocked(actorSrc, discord, newRoleName)
    if configEntry(discord) then
        return 'That Discord ID is set in config.lua. Change it there.'
    end
    local actor = actorRole(actorSrc)
    if actorSrc == 0 then return nil end
    if not actor.role then return 'You have no handling editor role.' end
    if actor.discord and actor.discord == discord then
        return 'You can\'t change your own access.'
    end
    if not actor.role.all then
        local current = stored[discord] and roles[stored[discord].role]
        if current and current.rank >= actor.role.rank then
            return 'They\'re at or above your rank.'
        end
        local wanted = newRoleName and roles[newRoleName]
        if wanted and wanted.rank >= actor.role.rank then
            return 'You can only give out roles below your own.'
        end
    end
    return nil
end

local function assignableRoles(actorSrc)
    local actor = actorRole(actorSrc)
    local out = {}
    for _, r in ipairs(roleList) do
        if actorSrc == 0 or (actor.role and (actor.role.all or r.rank < actor.role.rank)) then
            out[#out + 1] = r.name
        end
    end
    return out
end

local function changed(actorSrc, discord, line)
    local actor = Perms.describe(actorSrc)
    print(('[handling_editor] %s: %s'):format(actor.name, line))
    Webhook.send('access', 'Access changed', { line, ('Discord: <@%s> (%s)'):format(discord, discord) }, actor)
    for _, s in ipairs(onlineWithDiscord(discord)) do Perms.push(s) end
end

-- Returns ok, message.
function Perms.setUser(actorSrc, discord, roleName, label)
    if not validDiscord(discord) then return false, 'That isn\'t a Discord user ID (15-22 digits).' end
    local role = roles[roleName]
    if not role then return false, ('No role called "%s".'):format(tostring(roleName)) end
    local blocked = editBlocked(actorSrc, discord, roleName)
    if blocked then return false, blocked end

    local entry = stored[discord] or {}
    local was = entry.role
    entry.role = role.name
    if type(label) == 'string' and label:gsub('%s', '') ~= '' then
        entry.label = label:sub(1, 48)
    end
    if not entry.addedAt then
        entry.addedAt = os.time()
        entry.addedBy = Perms.describe(actorSrc).name
    end
    local online = onlineWithDiscord(discord)[1]
    if online then entry.name = GetPlayerName(online) end
    stored[discord] = entry
    persist()

    local who = entry.label or entry.name or discord
    if was and was ~= role.name then
        changed(actorSrc, discord, ('%s: %s -> %s'):format(who, roles[was] and roles[was].label or was, role.label))
    elseif not was then
        changed(actorSrc, discord, ('Added %s as %s'):format(who, role.label))
    end
    return true, ('%s is now %s.'):format(who, role.label)
end

function Perms.removeUser(actorSrc, discord)
    if not validDiscord(discord) then return false, 'That isn\'t a Discord user ID.' end
    if not stored[discord] then
        if configEntry(discord) then return false, 'That Discord ID is set in config.lua. Remove it there.' end
        return false, 'They aren\'t on the in-game list.'
    end
    local blocked = editBlocked(actorSrc, discord, nil)
    if blocked then return false, blocked end

    local entry = stored[discord]
    stored[discord] = nil
    persist()
    local who = entry.label or entry.name or discord
    changed(actorSrc, discord, ('Removed %s (was %s)'):format(who, roles[entry.role] and roles[entry.role].label or tostring(entry.role)))
    return true, ('Removed %s.'):format(who)
end

-- ---- events -----------------------------------------------------------------

-- The client asks this before opening the panel, so the panel only opens for
-- people who have `open`, and knows which tabs/buttons to show.
RegisterNetEvent('handling_editor:hello')
AddEventHandler('handling_editor:hello', function()
    local src = source
    local discord = Perms.discordOf(src)
    -- Keep the in-game list's "last seen as" name current.
    if discord and stored[discord] then
        local name = GetPlayerName(src)
        if name and stored[discord].name ~= name then
            stored[discord].name = name
            persist()
        end
    end
    Perms.push(src)
end)

-- ---- Access tab -------------------------------------------------------------

local function roleLabel(name)
    return roles[name] and roles[name].label or tostring(name)
end

RPC.register('access.list', 'manage', function(src)
    local actor = actorRole(src)
    local onlineByDiscord, online = {}, {}
    for _, id in ipairs(GetPlayers()) do
        local n = tonumber(id)
        if n then
            local res = Perms.resolve(n)
            local row = {
                id = n, name = GetPlayerName(n) or ('player ' .. n), discord = res.discord,
                role = res.role and res.role.name or nil, roleLabel = res.role and res.role.label or nil, via = res.via,
            }
            online[#online + 1] = row
            if res.discord then onlineByDiscord[res.discord] = row end
        end
    end
    table.sort(online, function(a, b) return a.id < b.id end)

    local users = {}
    local function add(discord, entry, source)
        local block = editBlocked(src, discord, nil)
        local on = onlineByDiscord[discord]
        users[#users + 1] = {
            discord = discord,
            label = entry.label,
            name = (on and on.name) or entry.name,
            role = entry.role,
            roleLabel = roleLabel(entry.role),
            rank = roles[entry.role] and roles[entry.role].rank or 0,
            source = source,
            addedBy = entry.addedBy,
            addedAt = entry.addedAt,
            online = on ~= nil,
            editable = block == nil,
            lockedReason = block,
        }
    end
    for discord in pairs(Config.Users or {}) do
        local c = configEntry(discord)
        if c then add(discord, c, 'config') end
    end
    for discord, entry in pairs(stored) do
        if not configEntry(discord) then add(discord, entry, 'in-game') end
    end
    table.sort(users, function(a, b)
        if a.rank ~= b.rank then return a.rank > b.rank end
        return (a.label or a.name or a.discord):lower() < (b.label or b.name or b.discord):lower()
    end)

    local roleRows = {}
    for _, r in ipairs(roleList) do
        local perms = {}
        for _, p in ipairs(ALL_PERMS) do if r.set[p] then perms[#perms + 1] = p end end
        roleRows[#roleRows + 1] = { name = r.name, label = r.label, rank = r.rank, perms = perms, all = r.all }
    end

    return {
        ok = true, now = os.time(), users = users, online = online, roles = roleRows,
        assignable = assignableRoles(src),
        me = { discord = actor.discord, role = actor.role and actor.role.name },
    }
end)

RPC.register('access.set', 'manage', function(src, args)
    local ok, message = Perms.setUser(src, tostring(args.discord or ''), args.role, args.label)
    return { ok = ok, message = message }
end)

RPC.register('access.remove', 'manage', function(src, args)
    local ok, message = Perms.removeUser(src, tostring(args.discord or ''))
    return { ok = ok, message = message }
end)

-- ---- `heperm` command (server console, or in-game with `manage`) -------------

local function reply(src, text)
    if src == 0 then
        print('[handling_editor] ' .. text)
    else
        TriggerClientEvent('chat:addMessage', src, { args = { '^5Handling Editor', text } })
    end
end

-- Accepts a Discord ID, or the server ID of an online player.
local function targetDiscord(arg)
    if type(arg) ~= 'string' then return nil, 'Give a Discord ID or an online player\'s server ID.' end
    if #arg <= 6 and tonumber(arg) then
        local n = tonumber(arg)
        if not GetPlayerName(n) then return nil, ('No player with server ID %s.'):format(arg) end
        local d = Perms.discordOf(n)
        if not d then return nil, ('%s has no Discord identifier (they need Discord open when they connect).'):format(GetPlayerName(n)) end
        return d, GetPlayerName(n)
    end
    if validDiscord(arg) then return arg end
    return nil, ('"%s" isn\'t a Discord ID or a server ID.'):format(arg)
end

local USAGE = 'heperm list | roles | whois <id> | add <discordId|serverId> <role> [label] | remove <discordId|serverId>'

RegisterCommand('heperm', function(src, args)
    if src ~= 0 and not Perms.has(src, 'manage') then
        reply(src, 'You need the manage permission for that.')
        return
    end
    local sub = (args[1] or ''):lower()

    if sub == 'list' then
        local count = 0
        for discord in pairs(Config.Users or {}) do
            local c = configEntry(discord)
            if c then
                reply(src, ('%s  %-8s  %s  (config.lua)'):format(discord, roleLabel(c.role), c.label or ''))
                count = count + 1
            end
        end
        for discord, e in pairs(stored) do
            if not configEntry(discord) then
                reply(src, ('%s  %-8s  %s  (in-game, added by %s)'):format(discord, roleLabel(e.role), e.label or e.name or '', e.addedBy or '?'))
                count = count + 1
            end
        end
        if count == 0 then reply(src, 'Nobody is on the list yet.') end
    elseif sub == 'roles' then
        for _, r in ipairs(roleList) do
            local perms = {}
            for _, p in ipairs(ALL_PERMS) do if r.set[p] then perms[#perms + 1] = p end end
            reply(src, ('%s (rank %d): %s'):format(r.name, r.rank, r.all and 'everything' or table.concat(perms, ', ')))
        end
    elseif sub == 'whois' then
        local n = tonumber(args[2] or '')
        if not n or not GetPlayerName(n) then
            reply(src, 'Usage: heperm whois <serverId>')
            return
        end
        local res = Perms.resolve(n)
        reply(src, ('%s: Discord %s, role %s%s'):format(GetPlayerName(n), res.discord or 'not linked',
            res.role and res.role.label or 'none', res.via and (' (via ' .. res.via .. ')') or ''))
    elseif sub == 'add' or sub == 'set' then
        local discord, nameOrErr = targetDiscord(args[2])
        if not discord then reply(src, nameOrErr) return end
        local label = table.concat(args, ' ', 4)
        if label == '' then label = nameOrErr end
        local _, message = Perms.setUser(src, discord, (args[3] or ''):lower(), label)
        reply(src, message)
    elseif sub == 'remove' or sub == 'del' then
        local discord, err = targetDiscord(args[2])
        if not discord then reply(src, err) return end
        local _, message = Perms.removeUser(src, discord)
        reply(src, message)
    else
        reply(src, 'Usage: ' .. USAGE)
    end
end, false)
