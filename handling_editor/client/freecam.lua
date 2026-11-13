-- Freecam: fly a detached camera around to look at the car from outside while
-- you tune it. Needs the `freecam` permission (the server confirms it), since
-- a freecam lets you see anywhere on the map.
--
-- While it's on, the game's controls are disabled (so the car coasts to a
-- stop and your ped stays put) and WASD/mouse drive the camera instead. If
-- the editor panel has the mouse (F6), the camera just holds still.

local Controls = {
    lookX = 1, lookY = 2,
    forward = 32, back = 33, left = 34, right = 35,
    down = 44,     -- Q
    up = 38,       -- E
    fast = 21,     -- Shift
    slow = 36,     -- Ctrl
    speedUp = 241, speedDown = 242, -- mouse wheel
}

-- Still usable while freecam is on: pause menu, chat, push-to-talk.
local KeepEnabled = { 199, 200, 245, 249 }

local MinSpeed, MaxSpeed = 0.5, 200.0
local LookSensitivity = 8.0

local cam = nil
local speed = 10.0 -- metres per second at normal speed
local pending = false

local function forwardVector(rot)
    local pitch, yaw = math.rad(rot.x), math.rad(rot.z)
    return vector3(-math.sin(yaw) * math.cos(pitch), math.cos(yaw) * math.cos(pitch), math.sin(pitch))
end

local function rightVector(rot)
    local yaw = math.rad(rot.z)
    return vector3(math.cos(yaw), math.sin(yaw), 0.0)
end

local function drawHint(text)
    SetTextFont(4)
    SetTextScale(0.0, 0.38)
    SetTextColour(255, 255, 255, 215)
    SetTextOutline()
    SetTextCentre(true)
    BeginTextCommandDisplayText('STRING')
    AddTextComponentSubstringPlayerName(text)
    EndTextCommandDisplayText(0.5, 0.93)
end

local function stopFreecam()
    if not cam then return end
    RenderScriptCams(false, true, 300, true, false)
    DestroyCam(cam, false)
    cam = nil
    ClearFocus()
    SendNUIMessage({ action = 'freecam', active = false })
end

local function startFreecam()
    if cam then return end
    cam = CreateCamWithParams('DEFAULT_SCRIPTED_CAMERA',
        GetGameplayCamCoord(), GetGameplayCamRot(2), GetGameplayCamFov(), true, 2)
    RenderScriptCams(true, true, 300, true, false)
    SendNUIMessage({ action = 'freecam', active = true })
    -- The camera needs the mouse, so hand it back from the panel if it had it.
    TriggerEvent('handling_editor:releaseFocus')

    CreateThread(function()
        while cam do
            DisableAllControlActions(0)
            for _, control in ipairs(KeepEnabled) do EnableControlAction(0, control, true) end
            HideHudAndRadarThisFrame()

            local pos = GetCamCoord(cam)
            if not IsNuiFocused() then
                local dt = GetFrameTime()
                local rot = GetCamRot(cam, 2)

                local pitch = rot.x - GetDisabledControlNormal(0, Controls.lookY) * LookSensitivity
                local yaw = rot.z - GetDisabledControlNormal(0, Controls.lookX) * LookSensitivity
                pitch = math.max(-89.0, math.min(89.0, pitch))
                rot = vector3(pitch, 0.0, yaw)
                SetCamRot(cam, rot.x, rot.y, rot.z, 2)

                if IsDisabledControlJustPressed(0, Controls.speedUp) then
                    speed = math.min(MaxSpeed, speed * 1.25)
                elseif IsDisabledControlJustPressed(0, Controls.speedDown) then
                    speed = math.max(MinSpeed, speed / 1.25)
                end

                local move = vector3(0.0, 0.0, 0.0)
                local fwd, right = forwardVector(rot), rightVector(rot)
                if IsDisabledControlPressed(0, Controls.forward) then move = move + fwd end
                if IsDisabledControlPressed(0, Controls.back) then move = move - fwd end
                if IsDisabledControlPressed(0, Controls.right) then move = move + right end
                if IsDisabledControlPressed(0, Controls.left) then move = move - right end
                if IsDisabledControlPressed(0, Controls.up) then move = move + vector3(0.0, 0.0, 1.0) end
                if IsDisabledControlPressed(0, Controls.down) then move = move - vector3(0.0, 0.0, 1.0) end

                local mult = 1.0
                if IsDisabledControlPressed(0, Controls.fast) then mult = 4.0 end
                if IsDisabledControlPressed(0, Controls.slow) then mult = 0.25 end

                if #move > 0.0 then
                    pos = pos + (move / #move) * speed * mult * dt
                    SetCamCoord(cam, pos.x, pos.y, pos.z)
                end

                drawHint(('Freecam  ~c~|~s~  WASD move  ~c~|~s~  Q/E down/up  ~c~|~s~  Shift fast, Ctrl slow  ~c~|~s~  Scroll speed (%.1f m/s)  ~c~|~s~  F6 edit  ~c~|~s~  F7 exit'):format(speed))
            end

            -- Stream the world around the camera, not around the player.
            SetFocusPosAndVel(pos.x, pos.y, pos.z, 0.0, 0.0, 0.0)
            Wait(0)
        end
    end)
end

local function toggleFreecam()
    if cam then
        stopFreecam()
    elseif not pending then
        pending = true
        TriggerServerEvent('handling_editor:freecam')
    end
end

RegisterNetEvent('handling_editor:freecamResult')
AddEventHandler('handling_editor:freecamResult', function(allowed)
    pending = false
    if allowed then
        startFreecam()
    else
        TriggerEvent('chat:addMessage', { args = { '^1Handling Editor', 'You don\'t have permission to use freecam.' } })
    end
end)

RegisterCommand('hefreecam', toggleFreecam, false)
RegisterKeyMapping('hefreecam', 'Handling editor: toggle freecam', 'keyboard', 'F7')

RegisterNUICallback('freecam', function(_, cb)
    toggleFreecam()
    cb('ok')
end)

AddEventHandler('onResourceStop', function(resourceName)
    if resourceName == GetCurrentResourceName() then stopFreecam() end
end)
