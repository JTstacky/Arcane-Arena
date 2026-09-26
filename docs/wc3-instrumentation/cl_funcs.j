//===========================================================================
// Claude instrumentation: 0.01 s logger + event log + scripted experiments.
// Output: Preload files Logs\claude_N.txt in the Warcraft III folder.
// Chat (red only): -cl dump | cam | cam0 | ne X | full | ts X | pw X | reset
//                  -cl exp1 (standing move turns) | exp2 (turns while walking)
//                  -cl exp3 (standing casts) | exp4 (turn-rate sweep) | exp5 (prop-window sweep)
//                  -cl exp6 (scripted knockback) | exp7 (real fireball knockback) | exp8 (lava)
//===========================================================================
function CL_T takes nothing returns string
    return R2SW(cl_base + TimerGetElapsed(cl_clock), 1, 4)
endfunction

function CL_ClockWrap takes nothing returns nothing
    set cl_base = cl_base + 1000.0
endfunction

function CL_Flush takes nothing returns nothing
    if cl_line != "" then
        set cl_buf[cl_n] = cl_line
        set cl_n = cl_n + 1
        set cl_line = ""
    endif
endfunction

function CL_Dump takes nothing returns nothing
    local integer i = 0
    call CL_Flush()
    call PreloadGenClear()
    call PreloadGenStart()
    loop
        exitwhen i >= cl_n
        call Preload(cl_buf[i])
        set i = i + 1
    endloop
    call PreloadGenEnd("Logs\\claude_" + I2S(cl_file) + ".txt")
    call DisplayTimedTextToPlayer(Player(0), 0, 0, 8, "CL: wrote Logs\\claude_" + I2S(cl_file) + ".txt, " + I2S(cl_n) + " lines")
    set cl_file = cl_file + 1
    set cl_n = 0
endfunction

function CL_Add takes string s returns nothing
    set cl_line = cl_line + s + ";"
    if StringLength(cl_line) > 150 then
        call CL_Flush()
        if cl_n >= 7000 then
            call CL_Dump()
        endif
    endif
endfunction

function CL_Msg takes string s returns nothing
    call DisplayTimedTextToPlayer(Player(0), 0, 0, 6, "CL: " + s)
    call CL_Add("M," + CL_T() + "," + s)
endfunction

function CL_SampleUnit takes unit u, integer p returns nothing
    local real x
    local real y
    local real f
    local real hp
    local real mp
    local integer o
    local integer i
    if u == null then
        return
    endif
    set x = GetUnitX(u)
    set y = GetUnitY(u)
    set f = GetUnitFacing(u)
    set o = GetUnitCurrentOrder(u)
    set i = GetUnitUserData(u)
    if x != cl_lx[p] or y != cl_ly[p] or f != cl_lf[p] or o != cl_lord[p] then
        set cl_lx[p] = x
        set cl_ly[p] = y
        set cl_lf[p] = f
        set cl_lord[p] = o
        call CL_Add("W" + I2S(p) + "," + CL_T() + "," + R2SW(x, 1, 2) + "," + R2SW(y, 1, 2) + "," + R2SW(f, 1, 2) + "," + I2S(o) + "," + R2SW(udg_ObjectSpeedX[i], 1, 3) + "," + R2SW(udg_ObjectSpeedY[i], 1, 3) + "," + I2S(cl_tickn))
    endif
    set hp = GetUnitState(u, UNIT_STATE_LIFE)
    set mp = GetUnitState(u, UNIT_STATE_MANA)
    if hp != cl_lhp[p] or mp != cl_lmp[p] then
        set cl_lhp[p] = hp
        set cl_lmp[p] = mp
        call CL_Add("H" + I2S(p) + "," + CL_T() + "," + R2SW(hp, 1, 3) + "," + R2SW(mp, 1, 3))
    endif
endfunction

function CL_SampleObj takes nothing returns nothing
    local unit u = GetEnumUnit()
    call CL_Add("O" + I2S(GetHandleId(u)) + "," + CL_T() + "," + R2SW(GetUnitX(u), 1, 1) + "," + R2SW(GetUnitY(u), 1, 1))
    set u = null
endfunction

function CL_Sample takes nothing returns nothing
    local integer p = 0
    if not cl_on then
        return
    endif
    loop
        exitwhen p > 11
        call CL_SampleUnit(udg_Warlocks[p + 1], p)
        set p = p + 1
    endloop
    set cl_tickn = cl_tickn + 1
    if ModuloInteger(cl_tickn, 3) == 0 then
        call ForGroup(udg_ObjectGroup, function CL_SampleObj)
    endif
endfunction

function CL_OnOrder takes nothing returns nothing
    local unit u = GetTriggerUnit()
    local eventid e = GetTriggerEventId()
    local string k = "I"
    local real x = 0
    local real y = 0
    if GetUnitTypeId(u) != 'h000' then
        set u = null
        return
    endif
    if e == EVENT_PLAYER_UNIT_ISSUED_POINT_ORDER then
        set k = "P"
        set x = GetOrderPointX()
        set y = GetOrderPointY()
    elseif e == EVENT_PLAYER_UNIT_ISSUED_TARGET_ORDER then
        set k = "T"
        set x = GetWidgetX(GetOrderTarget())
        set y = GetWidgetY(GetOrderTarget())
    endif
    call CL_Add("E" + k + "," + CL_T() + "," + I2S(GetPlayerId(GetOwningPlayer(u))) + "," + I2S(GetIssuedOrderId()) + "," + R2SW(x, 1, 1) + "," + R2SW(y, 1, 1) + "," + R2SW(GetUnitFacing(u), 1, 2) + "," + R2SW(GetUnitX(u), 1, 2) + "," + R2SW(GetUnitY(u), 1, 2))
    set u = null
endfunction

function CL_OnSpell takes nothing returns nothing
    local unit u = GetTriggerUnit()
    local eventid e = GetTriggerEventId()
    local string k = "??"
    if e == EVENT_PLAYER_UNIT_SPELL_CHANNEL then
        set k = "CH"
    elseif e == EVENT_PLAYER_UNIT_SPELL_CAST then
        set k = "CA"
    elseif e == EVENT_PLAYER_UNIT_SPELL_EFFECT then
        set k = "EF"
    elseif e == EVENT_PLAYER_UNIT_SPELL_FINISH then
        set k = "FI"
    elseif e == EVENT_PLAYER_UNIT_SPELL_ENDCAST then
        set k = "EN"
    endif
    call CL_Add("S" + k + "," + CL_T() + "," + I2S(GetPlayerId(GetOwningPlayer(u))) + "," + I2S(GetSpellAbilityId()) + "," + R2SW(GetUnitFacing(u), 1, 2) + "," + R2SW(GetUnitX(u), 1, 2) + "," + R2SW(GetUnitY(u), 1, 2))
    set u = null
endfunction

function CL_OnDamage takes nothing returns nothing
    local unit v = GetTriggerUnit()
    local unit s = GetEventDamageSource()
    call CL_Add("D," + CL_T() + "," + I2S(GetPlayerId(GetOwningPlayer(v))) + "," + I2S(GetPlayerId(GetOwningPlayer(s))) + "," + I2S(GetUnitTypeId(s)) + "," + R2SW(GetEventDamage(), 1, 3) + "," + R2SW(GetUnitX(s), 1, 2) + "," + R2SW(GetUnitY(s), 1, 2) + "," + R2SW(GetUnitX(v), 1, 2) + "," + R2SW(GetUnitY(v), 1, 2) + "," + R2SW(GetUnitState(v, UNIT_STATE_MANA), 1, 3))
    set v = null
    set s = null
endfunction

function CL_Cam takes nothing returns nothing
    call CL_Add("C," + CL_T() + ",dist=" + R2SW(GetCameraField(CAMERA_FIELD_TARGET_DISTANCE), 1, 3) + ",aoa=" + R2SW(GetCameraField(CAMERA_FIELD_ANGLE_OF_ATTACK), 1, 5) + ",fov=" + R2SW(GetCameraField(CAMERA_FIELD_FIELD_OF_VIEW), 1, 5) + ",rot=" + R2SW(GetCameraField(CAMERA_FIELD_ROTATION), 1, 5) + ",roll=" + R2SW(GetCameraField(CAMERA_FIELD_ROLL), 1, 5) + ",zoff=" + R2SW(GetCameraField(CAMERA_FIELD_ZOFFSET), 1, 3) + ",farz=" + R2SW(GetCameraField(CAMERA_FIELD_FARZ), 1, 1))
    call CL_Add("C2," + CL_T() + ",tx=" + R2SW(GetCameraTargetPositionX(), 1, 2) + ",ty=" + R2SW(GetCameraTargetPositionY(), 1, 2) + ",tz=" + R2SW(GetCameraTargetPositionZ(), 1, 2) + ",ex=" + R2SW(GetCameraEyePositionX(), 1, 2) + ",ey=" + R2SW(GetCameraEyePositionY(), 1, 2) + ",ez=" + R2SW(GetCameraEyePositionZ(), 1, 2))
    call CL_Msg("camera logged")
endfunction

function CL_Info takes unit u returns nothing
    call CL_Add("U," + CL_T() + ",turn=" + R2SW(GetUnitTurnSpeed(u), 1, 4) + ",turnDef=" + R2SW(GetUnitDefaultTurnSpeed(u), 1, 4) + ",prop=" + R2SW(GetUnitPropWindow(u), 1, 5) + ",propDef=" + R2SW(GetUnitDefaultPropWindow(u), 1, 5) + ",ms=" + R2SW(GetUnitMoveSpeed(u), 1, 3) + ",msDef=" + R2SW(GetUnitDefaultMoveSpeed(u), 1, 3) + ",acq=" + R2SW(GetUnitAcquireRange(u), 1, 1))
endfunction

function CL_Zero takes unit u returns nothing
    local integer i = GetUnitUserData(u)
    set udg_ObjectSpeedX[i] = 0
    set udg_ObjectSpeedY[i] = 0
endfunction

// Leave u standing at (x,y) facing angle a (deg): walk 250 units into place.
function CL_Stand takes unit u, real x, real y, real a returns nothing
    call CL_Zero(u)
    call SetUnitX(u, x - 250 * Cos(a * bj_DEGTORAD))
    call SetUnitY(u, y - 250 * Sin(a * bj_DEGTORAD))
    call IssuePointOrder(u, "move", x, y)
    call TriggerSleepAction(1.9)
endfunction

// kind 0: move order from standing; 1: cast Firebolt from standing; 2: move order while walking east
function CL_Trial takes unit u, integer kind, real a returns nothing
    local real x
    local real y
    if kind == 2 then
        call CL_Zero(u)
        call SetUnitX(u, -520)
        call SetUnitY(u, 0)
        call IssuePointOrder(u, "move", 1000, 0)
        call TriggerSleepAction(1.0)
    else
        call CL_Stand(u, 0, 0, 0)
    endif
    if kind == 1 then
        call UnitResetCooldown(u)
    endif
    set x = GetUnitX(u)
    set y = GetUnitY(u)
    call CL_Add("X," + CL_T() + ",trial," + I2S(kind) + "," + R2SW(a, 1, 1) + "," + R2SW(GetUnitTurnSpeed(u), 1, 4) + "," + R2SW(GetUnitPropWindow(u), 1, 5))
    if kind == 1 then
        call IssuePointOrder(u, "blizzard", x + 500 * Cos(a * bj_DEGTORAD), y + 500 * Sin(a * bj_DEGTORAD))
        call TriggerSleepAction(1.6)
    else
        call IssuePointOrder(u, "move", x + 500 * Cos(a * bj_DEGTORAD), y + 500 * Sin(a * bj_DEGTORAD))
        call TriggerSleepAction(1.3)
    endif
endfunction

function CL_Park takes nothing returns nothing
    local integer p = 1
    loop
        exitwhen p > 11
        if udg_Warlocks[p + 1] != null then
            call CL_Zero(udg_Warlocks[p + 1])
            call SetUnitX(udg_Warlocks[p + 1], -1000 + 40 * p)
            call SetUnitY(udg_Warlocks[p + 1], -1000)
            call IssueImmediateOrder(udg_Warlocks[p + 1], "stop")
        endif
        set p = p + 1
    endloop
endfunction

function CL_Sweep takes unit u, integer kind returns nothing
    local integer k = 0
    loop
        exitwhen k > 12
        call CL_Trial(u, kind, k * 15.0)
        set k = k + 1
    endloop
    if kind != 1 then
        call CL_Trial(u, kind, -45)
        call CL_Trial(u, kind, -90)
        call CL_Trial(u, kind, -150)
    endif
endfunction

function CL_Exp4 takes unit u returns nothing
    local real array ts
    local integer k = 0
    set ts[0] = 0.1
    set ts[1] = 0.2
    set ts[2] = 0.3
    set ts[3] = 0.45
    set ts[4] = 0.6
    set ts[5] = 1.0
    set ts[6] = 1.5
    set ts[7] = 3.0
    loop
        exitwhen k > 7
        call SetUnitTurnSpeed(u, ts[k])
        call CL_Info(u)
        call CL_Trial(u, 0, 90)
        call CL_Trial(u, 0, 180)
        call CL_Trial(u, 2, 90)
        set k = k + 1
    endloop
    call SetUnitTurnSpeed(u, GetUnitDefaultTurnSpeed(u))
    call CL_Info(u)
endfunction

function CL_Exp5 takes unit u returns nothing
    local real array pw
    local integer k = 0
    set pw[0] = 1
    set pw[1] = 15
    set pw[2] = 30
    set pw[3] = 45
    set pw[4] = 60
    set pw[5] = 90
    set pw[6] = 120
    set pw[7] = 180
    loop
        exitwhen k > 7
        call SetUnitPropWindow(u, pw[k] * bj_DEGTORAD)
        call CL_Info(u)
        call CL_Trial(u, 0, 90)
        call CL_Trial(u, 0, 180)
        call CL_Trial(u, 2, 90)
        set k = k + 1
    endloop
    call SetUnitPropWindow(u, 60 * bj_DEGTORAD)
    call CL_Info(u)
endfunction

function CL_KB takes unit src, unit vic, real ne, real d returns nothing
    call CL_Zero(src)
    call CL_Zero(vic)
    call IssueImmediateOrder(src, "stop")
    call IssueImmediateOrder(vic, "stop")
    call SetUnitX(vic, -700)
    call SetUnitY(vic, 300)
    call SetUnitX(src, -860)
    call SetUnitY(src, 300)
    call SetUnitState(vic, UNIT_STATE_LIFE, GetUnitState(vic, UNIT_STATE_MAX_LIFE))
    call SetUnitState(vic, UNIT_STATE_MANA, ne)
    call TriggerSleepAction(0.6)
    call CL_Add("X," + CL_T() + ",kb," + R2SW(ne, 1, 1) + "," + R2SW(d, 1, 1))
    call UnitDamageTarget(src, vic, d, true, false, ATTACK_TYPE_CHAOS, DAMAGE_TYPE_UNIVERSAL, WEAPON_TYPE_WHOKNOWS)
    call TriggerSleepAction(3.2)
endfunction

function CL_Exp6 takes nothing returns nothing
    local unit src = udg_Warlocks[1]
    local unit vic = udg_Warlocks[2]
    call CL_KB(src, vic, 0, 7)
    call CL_KB(src, vic, 25, 7)
    call CL_KB(src, vic, 43, 7)
    call CL_KB(src, vic, 75, 7)
    call CL_KB(src, vic, 93, 7)
    call CL_KB(src, vic, 0, 3)
    call CL_KB(src, vic, 0, 14)
    call CL_KB(src, vic, 50, 14)
    set src = null
    set vic = null
endfunction

function CL_FB takes unit src, unit vic, real ne returns nothing
    call CL_Stand(src, -500, 0, 0)
    call CL_Zero(vic)
    call IssueImmediateOrder(vic, "stop")
    call SetUnitX(vic, -150)
    call SetUnitY(vic, 0)
    call SetUnitState(vic, UNIT_STATE_LIFE, GetUnitState(vic, UNIT_STATE_MAX_LIFE))
    call SetUnitState(vic, UNIT_STATE_MANA, ne)
    call UnitResetCooldown(src)
    call TriggerSleepAction(0.5)
    call CL_Add("X," + CL_T() + ",fb," + R2SW(ne, 1, 1))
    call IssuePointOrder(src, "blizzard", 500, 0)
    call TriggerSleepAction(3.5)
endfunction

function CL_Exp7 takes nothing returns nothing
    call CL_FB(udg_Warlocks[1], udg_Warlocks[2], 0)
    call CL_FB(udg_Warlocks[1], udg_Warlocks[2], 43)
    call CL_FB(udg_Warlocks[1], udg_Warlocks[2], 93)
endfunction

function CL_Exp8 takes unit u returns nothing
    call CL_Zero(u)
    call SetUnitState(u, UNIT_STATE_LIFE, GetUnitState(u, UNIT_STATE_MAX_LIFE))
    call SetUnitState(u, UNIT_STATE_MANA, 0)
    call SetUnitX(u, 900)
    call SetUnitY(u, 0)
    call IssuePointOrder(u, "move", 1400, 0)
    call CL_Add("X," + CL_T() + ",lava")
    call TriggerSleepAction(5.0)
    call IssuePointOrder(u, "move", 0, 0)
    call TriggerSleepAction(6.0)
    call CL_Add("X," + CL_T() + ",lavaend")
endfunction

function CL_OnChat takes nothing returns nothing
    local string s = GetEventPlayerChatString()
    local unit u = udg_Warlocks[1]
    local integer n = StringLength(s)
    if SubString(s, 0, 4) != "-cl " then
        set u = null
        return
    endif
    set s = SubString(s, 4, n)
    set n = StringLength(s)
    call CL_Add("K," + CL_T() + "," + s)
    if s == "dump" then
        call CL_Dump()
    elseif s == "cam" then
        call CL_Cam()
    elseif s == "cam0" then
        call SetCameraPosition(0, 0)
        call CL_Cam()
    elseif s == "full" then
        call SetUnitState(u, UNIT_STATE_LIFE, GetUnitState(u, UNIT_STATE_MAX_LIFE))
        call SetUnitState(udg_Warlocks[2], UNIT_STATE_LIFE, GetUnitState(udg_Warlocks[2], UNIT_STATE_MAX_LIFE))
    elseif SubString(s, 0, 3) == "ne " then
        call SetUnitState(udg_Warlocks[2], UNIT_STATE_MANA, S2R(SubString(s, 3, n)))
    elseif SubString(s, 0, 3) == "ts " then
        call SetUnitTurnSpeed(u, S2R(SubString(s, 3, n)))
        call CL_Info(u)
    elseif SubString(s, 0, 3) == "pw " then
        call SetUnitPropWindow(u, S2R(SubString(s, 3, n)) * bj_DEGTORAD)
        call CL_Info(u)
    elseif s == "reset" then
        call SetUnitTurnSpeed(u, GetUnitDefaultTurnSpeed(u))
        call SetUnitPropWindow(u, 60 * bj_DEGTORAD)
        call CL_Info(u)
    elseif s == "info" then
        call CL_Info(u)
        call CL_Msg("info logged")
    elseif SubString(s, 0, 3) == "exp" then
        if cl_busy then
            call CL_Msg("busy")
        else
            set cl_busy = true
            call CL_Msg("start " + s)
            call CL_Info(u)
            if s != "exp6" and s != "exp7" then
                call CL_Park()
            endif
            if s == "exp1" then
                call CL_Sweep(u, 0)
            elseif s == "exp2" then
                call CL_Sweep(u, 2)
            elseif s == "exp3" then
                call CL_Sweep(u, 1)
            elseif s == "exp4" then
                call CL_Exp4(u)
            elseif s == "exp5" then
                call CL_Exp5(u)
            elseif s == "exp6" then
                call CL_Exp6()
            elseif s == "exp7" then
                call CL_Exp7()
            elseif s == "exp8" then
                call CL_Exp8(u)
            endif
            call IssueImmediateOrder(u, "stop")
            call CL_Msg("done " + s)
            call CL_Dump()
            set cl_busy = false
        endif
    endif
    set u = null
endfunction

function CL_Init takes nothing returns nothing
    local trigger t
    local integer p = 0
    set cl_clock = CreateTimer()
    call TimerStart(cl_clock, 1000.0, true, function CL_ClockWrap)
    set cl_tick = CreateTimer()
    call TimerStart(cl_tick, 0.01, true, function CL_Sample)
    set t = CreateTrigger()
    loop
        exitwhen p > 11
        call TriggerRegisterPlayerUnitEvent(t, Player(p), EVENT_PLAYER_UNIT_ISSUED_POINT_ORDER, null)
        call TriggerRegisterPlayerUnitEvent(t, Player(p), EVENT_PLAYER_UNIT_ISSUED_TARGET_ORDER, null)
        call TriggerRegisterPlayerUnitEvent(t, Player(p), EVENT_PLAYER_UNIT_ISSUED_ORDER, null)
        set p = p + 1
    endloop
    call TriggerAddAction(t, function CL_OnOrder)
    set t = CreateTrigger()
    set p = 0
    loop
        exitwhen p > 11
        call TriggerRegisterPlayerUnitEvent(t, Player(p), EVENT_PLAYER_UNIT_SPELL_CHANNEL, null)
        call TriggerRegisterPlayerUnitEvent(t, Player(p), EVENT_PLAYER_UNIT_SPELL_CAST, null)
        call TriggerRegisterPlayerUnitEvent(t, Player(p), EVENT_PLAYER_UNIT_SPELL_EFFECT, null)
        call TriggerRegisterPlayerUnitEvent(t, Player(p), EVENT_PLAYER_UNIT_SPELL_FINISH, null)
        call TriggerRegisterPlayerUnitEvent(t, Player(p), EVENT_PLAYER_UNIT_SPELL_ENDCAST, null)
        set p = p + 1
    endloop
    call TriggerAddAction(t, function CL_OnSpell)
    set cl_dmg = CreateTrigger()
    set p = 1
    loop
        exitwhen p > 12
        if udg_Warlocks[p] != null then
            call TriggerRegisterUnitEvent(cl_dmg, udg_Warlocks[p], EVENT_UNIT_DAMAGED)
        endif
        set p = p + 1
    endloop
    call TriggerAddAction(cl_dmg, function CL_OnDamage)
    set t = CreateTrigger()
    call TriggerRegisterPlayerChatEvent(t, Player(0), "-cl ", false)
    call TriggerAddAction(t, function CL_OnChat)
    call CL_Add("B," + CL_T() + ",claude-instrumented Warlock 099")
    if udg_Warlocks[1] != null then
        call CL_Info(udg_Warlocks[1])
    endif
    set t = null
endfunction
//===========================================================================
