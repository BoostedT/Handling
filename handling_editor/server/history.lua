-- Save history: every write to a handling.meta (single save, copy, preset onto
-- another vehicle, vMenu category, restore) is logged with who did it and the
-- before/after of each field it changed. The History tab lists these and can
-- roll one back (server/main.lua does the restore, since it owns the file code).
--
-- Kept in KVP as one key per entry (h:<id>) plus a counter, so a big category
-- save doesn't have to fit in one value with everything else. Only the newest
-- Config.HistoryLimit entries are kept.
--
-- Entry: { id, t, kind = 'save' | 'bulk' | 'restore', label, by = { name, discord },
--          targets = { { handling, resource, file, changes = { { f, old, new } } } },
--          total, restorable, restoredBy = { name, t, id } }

History = {}

local seq = GetResourceKvpInt('h:seq') or 0

local function limit()
    return math.max(10, tonumber(Config.HistoryLimit) or 400)
end

function History.add(entry)
    seq = seq + 1
    entry.id = seq
    entry.t = os.time()
    Store.set('h:' .. seq, entry)
    SetResourceKvpInt('h:seq', seq)
    local drop = seq - limit()
    if drop > 0 then DeleteResourceKvp('h:' .. drop) end
    return entry
end

function History.get(id)
    id = tonumber(id)
    if not id or id < 1 or id > seq or id <= seq - limit() then return nil end
    local entry = Store.get('h:' .. math.floor(id))
    return type(entry) == 'table' and entry or nil
end

function History.update(entry)
    if entry and entry.id then Store.set('h:' .. entry.id, entry) end
end

local function matchingTargets(entry, upper)
    local out = {}
    for _, target in ipairs(entry.targets or {}) do
        if not upper or (type(target.handling) == 'string' and target.handling:upper() == upper) then
            out[#out + 1] = target
        end
    end
    return out
end

-- Newest first. `handling` (optional) keeps only entries that touched it, and
-- only shows that vehicle's part of a bigger save.
function History.list(handling, max)
    local upper = type(handling) == 'string' and handling ~= '' and handling:upper() or nil
    max = math.min(tonumber(max) or 60, 200)
    local out = {}
    local stop = math.max(1, seq - limit() + 1)
    for id = seq, stop, -1 do
        local entry = Store.get('h:' .. id)
        if type(entry) == 'table' then
            local targets = matchingTargets(entry, upper)
            if #targets > 0 then
                local shown = {}
                for i = 1, math.min(#targets, upper and #targets or 6) do shown[i] = targets[i] end
                out[#out + 1] = {
                    id = entry.id, t = entry.t, kind = entry.kind, label = entry.label, by = entry.by,
                    total = entry.total or #(entry.targets or {}),
                    restorable = entry.restorable ~= false, restoredBy = entry.restoredBy,
                    targets = shown,
                }
                if #out >= max then break end
            end
        end
    end
    return out
end

RPC.register('history.list', 'history', function(src, args)
    return { ok = true, now = os.time(), entries = History.list(args.handling, args.limit), handling = args.handling }
end)
