-- Small shared helpers for the other server files:
--   Store    JSON values in this resource's server-side KVP (kept in the
--            server's own database folder, not in the resource, so nothing
--            here shows up in git or gets overwritten by an SFTP upload).
--   Webhook  optional Discord log, URL from a convar (see config.lua).
--   RPC      request/response calls from the panel. Each handler names the
--            permission it needs; the dispatcher checks it before running.

Store = {}

function Store.get(key, fallback)
    local raw = GetResourceKvpString(key)
    if not raw or raw == '' then return fallback end
    local ok, value = pcall(json.decode, raw)
    if not ok or value == nil then return fallback end
    return value
end

function Store.set(key, value)
    if value == nil then
        DeleteResourceKvp(key)
    else
        SetResourceKvp(key, json.encode(value))
    end
end

-- ---- Discord webhook --------------------------------------------------------

Webhook = {}

local COLORS = { save = 0x5B8CFF, bulk = 0x8F6BFF, restore = 0xE8B34C, lock = 0xEC7B74, access = 0x6FD08C }

-- `actor` is Perms.describe(src). `lines` is a list of strings.
function Webhook.send(kind, title, lines, actor)
    local url = GetConvar(Config.WebhookConvar or 'handling_editor_webhook', '')
    if url == '' then return end

    local text = table.concat(lines or {}, '\n')
    if #text > 3900 then text = text:sub(1, 3900) .. '\n...' end

    local footer = actor and actor.name or 'console'
    if actor and actor.discord then footer = footer .. ' (' .. actor.discord .. ')' end

    local body = {
        username = 'Handling Editor',
        allowed_mentions = { parse = {} }, -- show <@id> mentions without pinging anyone
        embeds = { {
            title = title,
            description = text,
            color = COLORS[kind] or COLORS.save,
            footer = { text = footer },
            timestamp = os.date('!%Y-%m-%dT%H:%M:%SZ'),
        } },
    }
    PerformHttpRequest(url, function(status)
        if status and status >= 400 then
            print(('[handling_editor] webhook returned HTTP %s'):format(tostring(status)))
        end
    end, 'POST', json.encode(body), { ['Content-Type'] = 'application/json' })
end

-- ---- RPC --------------------------------------------------------------------

RPC = {}

-- RPC.register('history.list', 'history', function(src, args) return { ok = true, ... } end)
-- perm may be a function(src, args) -> bool for checks that depend on the args.
function RPC.register(name, perm, fn)
    RPC[name] = { perm = perm, fn = fn }
end

RegisterNetEvent('handling_editor:rpc')
AddEventHandler('handling_editor:rpc', function(id, name, args)
    local src = source
    local function reply(result)
        TriggerClientEvent('handling_editor:rpcResult', src, id, name, result)
    end

    local handler = type(name) == 'string' and RPC[name]
    if type(handler) ~= 'table' then
        reply({ ok = false, message = 'Unknown request.' })
        return
    end
    if type(args) ~= 'table' then args = {} end

    local allowed
    if type(handler.perm) == 'function' then
        allowed = handler.perm(src, args)
    else
        allowed = Perms.has(src, handler.perm)
    end
    if not allowed then
        reply({ ok = false, denied = true, message = 'Your handling editor role doesn\'t allow that.' })
        return
    end

    local ok, result = pcall(handler.fn, src, args)
    if not ok then
        print(('[handling_editor] request "%s" from %s failed: %s'):format(name, tostring(src), tostring(result)))
        result = { ok = false, message = 'The server hit an error handling that. See the server console.' }
    end
    reply(type(result) == 'table' and result or { ok = true })
end)
