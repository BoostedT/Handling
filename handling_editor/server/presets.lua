-- Shared presets: the same "fields you edited" presets as the panel's local
-- ones, but kept on the server so every staff member sees them. Anyone who can
-- open the editor can list and apply them; `publish` shares new ones and
-- deletes your own; `manage` can delete anyone's.

local presets = Store.get('presets', {})
if type(presets) ~= 'table' then presets = {} end

local function persist()
    Store.set('presets', presets)
end

local function finite(n)
    return type(n) == 'number' and n == n and n ~= math.huge and n ~= -math.huge
end

-- Only known fields, each in the shape its type needs.
local function sanitize(values)
    local out, count = {}, 0
    if type(values) ~= 'table' then return out, 0 end
    for name, raw in pairs(values) do
        local field = type(name) == 'string' and Handling.ByName[name]
        local v = nil
        if field then
            if field.type == 'float' or field.type == 'int' then
                local n = tonumber(raw)
                if finite(n) then v = n end
            elseif field.type == 'vector' then
                if type(raw) == 'table' then
                    local x, y, z = tonumber(raw.x), tonumber(raw.y), tonumber(raw.z)
                    if finite(x) and finite(y) and finite(z) then v = { x = x, y = y, z = z } end
                end
            elseif field.type == 'flags' then
                if type(raw) == 'string' and raw:match('^%x+$') and #raw <= 16 then v = raw end
            elseif field.type == 'string' then
                if type(raw) == 'string' then v = raw:gsub('[<>&]', ''):sub(1, 64) end
            end
        end
        if v ~= nil then
            out[name] = v
            count = count + 1
        end
    end
    return out, count
end

-- Who owns a preset: their Discord ID, or their license for people who get
-- access from an ACE without Discord linked. Stored with the preset but never
-- sent to other players.
local function ownerKey(src)
    local discord = Perms.discordOf(src)
    if discord then return 'discord:' .. discord end
    local license = src ~= 0 and GetPlayerIdentifierByType and GetPlayerIdentifierByType(src, 'license') or nil
    return license
end

-- Who's asking, worked out once per request.
local function asker(src)
    return {
        key = ownerKey(src),
        manage = src == 0 or Perms.has(src, 'manage'),
        publish = src == 0 or Perms.has(src, 'publish'),
    }
end

local function isMine(who, preset)
    return who.key ~= nil and preset.owner == who.key
end

-- Your own (while you can still publish), or anyone's with manage.
local function canDelete(who, preset)
    return who.manage or (who.publish and isMine(who, preset))
end

local function listFor(src)
    local who = asker(src)
    local out = {}
    for _, p in ipairs(presets) do
        out[#out + 1] = {
            id = p.id, name = p.name, values = p.values, by = p.by, t = p.t,
            mine = isMine(who, p),
            canDelete = canDelete(who, p),
        }
    end
    return out
end

RPC.register('presets.list', 'open', function(src)
    return { ok = true, now = os.time(), presets = listFor(src) }
end)

RPC.register('presets.publish', 'publish', function(src, args)
    local name = type(args.name) == 'string' and args.name:gsub('^%s+', ''):gsub('%s+$', ''):sub(1, 60) or ''
    if name == '' then return { ok = false, message = 'Name the preset first.' } end
    local values, count = sanitize(args.values)
    if count == 0 then return { ok = false, message = 'That preset has no usable fields.' } end

    local actor = Perms.describe(src)
    local who = asker(src)
    for _, p in ipairs(presets) do
        if p.name:lower() == name:lower() then
            if not isMine(who, p) and not who.manage then
                return { ok = false, message = ('"%s" is already shared by %s. Pick another name.'):format(p.name, p.by and p.by.name or 'someone') }
            end
            p.values, p.t, p.by = values, os.time(), actor
            p.owner = p.owner or who.key
            persist()
            return { ok = true, message = ('Updated shared preset "%s".'):format(p.name), presets = listFor(src) }
        end
    end

    if #presets >= (Config.MaxSharedPresets or 200) then
        return { ok = false, message = 'The server already has the maximum number of shared presets. Delete some first.' }
    end
    presets[#presets + 1] = {
        id = ('%x%04x'):format(os.time(), math.random(0, 0xffff)),
        name = name, values = values, by = actor, t = os.time(), owner = who.key,
    }
    persist()
    print(('[handling_editor] %s shared preset "%s" (%d fields)'):format(actor.name, name, count))
    return { ok = true, message = ('Shared "%s" with everyone (%d field%s).'):format(name, count, count == 1 and '' or 's'), presets = listFor(src) }
end)

local function publishOrManage(src)
    return Perms.has(src, 'publish') or Perms.has(src, 'manage')
end

RPC.register('presets.delete', publishOrManage, function(src, args)
    for i, p in ipairs(presets) do
        if p.id == args.id then
            if not canDelete(asker(src), p) then
                return { ok = false, message = 'You can only delete presets you shared.' }
            end
            table.remove(presets, i)
            persist()
            print(('[handling_editor] %s deleted shared preset "%s"'):format(Perms.describe(src).name, p.name))
            return { ok = true, message = ('Deleted shared preset "%s".'):format(p.name), presets = listFor(src) }
        end
    end
    return { ok = false, message = 'That preset is already gone.', presets = listFor(src) }
end)
