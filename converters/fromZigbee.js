'use strict';

/**
 * Documentation of convert() parameters
 * - model: zigbee-herdsman-converters definition (form devices.js)
 * - msg: message data property
 * - publish: publish method
 * - options: converter options object, e.g. {occupancy_timeout: 120}
 * - meta: object containing {device: (zigbee-herdsman device object)}
 */

const common = require('./common');
const utils = require('./utils');
const {precisionRound, isLegacyEnabled, toLocalISOString} = require('../lib/utils');
const globalStore = require('./store');

const occupancyTimeout = 90; // In seconds

const defaultPrecision = {
    temperature: 2,
    humidity: 2,
    pressure: 1,
};

const tuyaGetDataValue = (dataType, data) => {
    switch (dataType) {
    case common.TuyaDataTypes.raw:
        return data;
    case common.TuyaDataTypes.bool:
        return data[0] === 1;
    case common.TuyaDataTypes.value:
        return utils.convertMultiByteNumberPayloadToSingleDecimalNumber(data);
    case common.TuyaDataTypes.string:
        // eslint-disable-next-line
        let dataString = '';
        // Don't use .map here, doesn't work: https://github.com/Koenkk/zigbee-herdsman-converters/pull/1799/files#r530377091
        for (let i = 0; i < data.length; ++i) {
            dataString += String.fromCharCode(data[i]);
        }
        return dataString;
    case common.TuyaDataTypes.enum:
        return data[0];
    case common.TuyaDataTypes.bitmap:
        return utils.convertMultiByteNumberPayloadToSingleDecimalNumber(data);
    }
};

const calibrateAndPrecisionRoundOptions = (number, options, type) => {
    // Calibrate
    const calibrateKey = `${type}_calibration`;
    let calibrationOffset = options && options.hasOwnProperty(calibrateKey) ? options[calibrateKey] : 0;
    if (type == 'illuminance' || type === 'illuminance_lux') {
        // linear calibration because measured value is zero based
        // +/- percent
        calibrationOffset = Math.round(number * calibrationOffset / 100);
    }
    number = number + calibrationOffset;

    // Precision round
    const precisionKey = `${type}_precision`;
    const defaultValue = defaultPrecision[type] || 0;
    const precision = options && options.hasOwnProperty(precisionKey) ? options[precisionKey] : defaultValue;
    return precisionRound(number, precision);
};

const toPercentage = (value, min, max) => {
    if (value > max) {
        value = max;
    } else if (value < min) {
        value = min;
    }

    const normalised = (value - min) / (max - min);
    return Math.round(normalised * 100);
};

const toPercentage3V = (voltage) => {
    let percentage = null;

    if (voltage < 2100) {
        percentage = 0;
    } else if (voltage < 2440) {
        percentage = 6 - ((2440 - voltage) * 6) / 340;
    } else if (voltage < 2740) {
        percentage = 18 - ((2740 - voltage) * 12) / 300;
    } else if (voltage < 2900) {
        percentage = 42 - ((2900 - voltage) * 24) / 160;
    } else if (voltage < 3000) {
        percentage = 100 - ((3000 - voltage) * 58) / 100;
    } else if (voltage >= 3000) {
        percentage = 100;
    }

    return Math.round(percentage);
};

const numberWithinRange = (number, min, max) => {
    if (number > max) {
        return max;
    } else if (number < min) {
        return min;
    } else {
        return number;
    }
};

// get object property name (key) by it's value
const getKey = (object, value) => {
    for (const key in object) {
        if (object[key]==value) return key;
    }
};

// Global variable store that can be used by devices.
const store = {};

const postfixWithEndpointName = (name, msg, definition) => {
    if (definition.meta && definition.meta.multiEndpoint) {
        const endpointName = definition.hasOwnProperty('endpoint') ?
            getKey(definition.endpoint(msg.device), msg.endpoint.ID) : msg.endpoint.ID;
        return `${name}_${endpointName}`;
    } else {
        return name;
    }
};

const addActionGroup = (payload, msg, definition) => {
    const disableActionGroup = definition.meta && definition.meta.disableActionGroup;
    if (!disableActionGroup && msg.groupID) {
        payload.action_group = msg.groupID;
    }
};

const transactionStore = {};
const hasAlreadyProcessedMessage = (msg, transaction=null, key=null) => {
    const current = transaction !== null ? transaction : msg.meta.zclTransactionSequenceNumber;
    key = key || msg.device.ieeeAddr;
    if (transactionStore[key] === current) return true;
    transactionStore[key] = current;
    return false;
};

const holdUpdateBrightness324131092621 = (deviceID) => {
    if (store[deviceID] && store[deviceID].brightnessSince && store[deviceID].brightnessDirection) {
        const duration = Date.now() - store[deviceID].brightnessSince;
        const delta = (duration / 10) * (store[deviceID].brightnessDirection === 'up' ? 1 : -1);
        const newValue = store[deviceID].brightnessValue + delta;
        store[deviceID].brightnessValue = numberWithinRange(newValue, 1, 255);
    }
};

const moesThermostat = (model, msg, publish, options, meta) => {
    const dp = msg.data.dp;
    const value = tuyaGetDataValue(msg.data.datatype, msg.data.data);
    let temperature;
    /* See tuyaThermostat above for message structure comment */
    switch (dp) {
    case common.TuyaDataPoints.moesSchedule:
        return {
            program: [
                {p1: value[0] + 'h:' + value[1] + 'm ' + value[2] + '°C'},
                {p2: value[3] + 'h:' + value[4] + 'm ' + value[5] + '°C'},
                {p3: value[6] + 'h:' + value[7] + 'm ' + value[8] + '°C'},
                {p4: value[9] + 'h:' + value[10] + 'm ' + value[11] + '°C'},
                {sa1: value[12] + 'h:' + value[13] + 'm ' + value[14] + '°C'},
                {sa2: value[15] + 'h:' + value[16] + 'm ' + value[17] + '°C'},
                {sa3: value[18] + 'h:' + value[19] + 'm ' + value[20] + '°C'},
                {sa4: value[21] + 'h:' + value[22] + 'm ' + value[23] + '°C'},
                {su1: value[24] + 'h:' + value[25] + 'm ' + value[26] + '°C'},
                {su2: value[27] + 'h:' + value[28] + 'm ' + value[29] + '°C'},
                {su3: value[30] + 'h:' + value[31] + 'm ' + value[32] + '°C'},
                {su4: value[33] + 'h:' + value[34] + 'm ' + value[35] + '°C'},
            ],
        };
    case common.TuyaDataPoints.state: // Thermostat on standby = OFF, running = ON
        return {system_mode: value ? 'heat' : 'off'};
    case common.TuyaDataPoints.childLock:
        return {child_lock: value ? 'LOCKED' : 'UNLOCKED'};
    case common.TuyaDataPoints.moesHeatingSetpoint:
        return {current_heating_setpoint: value};
    case common.TuyaDataPoints.moesMaxTempLimit:
        return {max_temperature_limit: value};
    case common.TuyaDataPoints.moesMaxTemp:
        return {max_temperature: value};
    case common.TuyaDataPoints.moesMinTemp:
        return {min_temperature: value};
    case common.TuyaDataPoints.moesLocalTemp:
        return {local_temperature: parseFloat((value / 10).toFixed(1))};
    case common.TuyaDataPoints.moesTempCalibration:
        temperature = value;
        // for negative values produce complimentary hex (equivalent to negative values)
        if (temperature > 4000) temperature = temperature - 4096;
        return {local_temperature_calibration: temperature};
    case common.TuyaDataPoints.moesHold: // state is inverted
        return {preset_mode: value ? 'program' : 'hold'};
    case common.TuyaDataPoints.moesScheduleEnable: // state is inverted
        return {preset_mode: value ? 'hold' : 'program'};
    case common.TuyaDataPoints.moesValve:
        return {heat: value ? 'OFF' : 'ON'};
    case common.TuyaDataPoints.moesSensor:
        switch (value) {
        case 0:
            return {sensor: 'IN'};
        case 1:
            return {sensor: 'AL'};
        case 2:
            return {sensor: 'OU'};
        default:
            return {sensor: 'Not supported'};
        }
    default: // DataPoint 17 is unknown
        meta.logger.warn(`zigbee-herdsman-converters:Moes BHT-002: NOT RECOGNIZED DP #${
            dp} with data ${JSON.stringify(msg.data)}`);
    }
};
function utf8FromStr(s) {
    const a = [];
    for (let i = 0, enc = encodeURIComponent(s); i < enc.length;) {
        if (enc[i] === '%') {
            a.push(parseInt(enc.substr(i + 1, 2), 16));
            i += 3;
        } else {
            a.push(enc.charCodeAt(i++));
        }
    }
    return a;
}

const eTopThermostat = (model, msg, publish, options, meta) => {
    const dp = msg.data.dp;
    const value = tuyaGetDataValue(msg.data.datatype, msg.data.data);

    if (dp >= 101 && dp <=107) return; // handled by tuya_thermostat_weekly_schedule

    switch (dp) {
    case common.TuyaDataPoints.state: // on/off
        return !value ? {system_mode: 'off'} : {};
    case common.TuyaDataPoints.etopErrorStatus:
        return {
            high_temperature: (value & 1<<0) > 0 ? 'ON' : 'OFF',
            low_temperature: (value & 1<<1) > 0 ? 'ON' : 'OFF',
            internal_sensor_error: (value & 1<<2) > 0 ? 'ON' : 'OFF',
            external_sensor_error: (value & 1<<3) > 0 ? 'ON' : 'OFF',
            battery_low: (value & 1<<4) > 0 ? 'ON' : 'OFF',
            device_offline: (value & 1<<5) > 0 ? 'ON' : 'OFF',
        };
    case common.TuyaDataPoints.childLock:
        return {child_lock: value ? 'LOCKED' : 'UNLOCKED'};
    case common.TuyaDataPoints.heatingSetpoint:
        return {current_heating_setpoint: (value / 10).toFixed(1)};
    case common.TuyaDataPoints.localTemp:
        return {local_temperature: (value / 10).toFixed(1)};
    case common.TuyaDataPoints.mode:
        switch (value) {
        case 0: // manual
            return {system_mode: 'heat', away_mode: 'OFF', preset: 'none'};
        case 1: // away
            return {system_mode: 'heat', away_mode: 'ON', preset: 'away'};
        case 2: // auto
            return {system_mode: 'auto', away_mode: 'OFF', preset: 'none'};
        default:
            meta.logger.warn('zigbee-herdsman-converters:eTopThermostat: ' +
                `preset ${value} is not recognized.`);
            break;
        }
        break;
    case common.TuyaDataPoints.runningState:
        return {running_state: value ? 'heat' : 'idle'};
    default:
        meta.logger.warn(`zigbee-herdsman-converters:eTopThermostat: NOT RECOGNIZED DP #${
            dp} with data ${JSON.stringify(msg.data)}`);
    }
};

const tuyaThermostat = (model, msg, publish, options, meta) => {
    const dp = msg.data.dp;
    const value = tuyaGetDataValue(msg.data.datatype, msg.data.data);

    switch (dp) {
    case common.TuyaDataPoints.windowDetection:
        return {
            window_detection: value[0] ? 'ON' : 'OFF',
            window_detection_params: {
                temperature: value[1],
                minutes: value[2],
            },
        };
    case common.TuyaDataPoints.scheduleWorkday: // set schedule for workdays [6,0,20,8,0,15,11,30,15,12,30,15,17,30,20,22,0,15]
        // 6:00 - 20*, 8:00 - 15*, 11:30 - 15*, 12:30 - 15*, 17:30 - 20*, 22:00 - 15*
        // Top bits in hours have special meaning
        // 8: ??
        // 7: Current schedule indicator
        return {workdays: [
            {hour: value[0] & 0x3F, minute: value[1], temperature: value[2]},
            {hour: value[3] & 0x3F, minute: value[4], temperature: value[5]},
            {hour: value[6] & 0x3F, minute: value[7], temperature: value[8]},
            {hour: value[9] & 0x3F, minute: value[10], temperature: value[11]},
            {hour: value[12] & 0x3F, minute: value[13], temperature: value[14]},
            {hour: value[15] & 0x3F, minute: value[16], temperature: value[17]},
        ]};
    case common.TuyaDataPoints.scheduleHoliday: // set schedule for holidays [6,0,20,8,0,15,11,30,15,12,30,15,17,30,20,22,0,15]
        // 6:00 - 20*, 8:00 - 15*, 11:30 - 15*, 12:30 - 15*, 17:30 - 20*, 22:00 - 15*
        // Top bits in hours have special meaning
        // 8: ??
        // 7: Current schedule indicator
        return {holidays: [
            {hour: value[0] & 0x3F, minute: value[1], temperature: value[2]},
            {hour: value[3] & 0x3F, minute: value[4], temperature: value[5]},
            {hour: value[6] & 0x3F, minute: value[7], temperature: value[8]},
            {hour: value[9] & 0x3F, minute: value[10], temperature: value[11]},
            {hour: value[12] & 0x3F, minute: value[13], temperature: value[14]},
            {hour: value[15] & 0x3F, minute: value[16], temperature: value[17]},
        ]};
    case common.TuyaDataPoints.childLock:
        return {child_lock: value ? 'LOCKED' : 'UNLOCKED'};
    case common.TuyaDataPoints.siterwellWindowDetection:
        return {window_detection: value ? 'ON' : 'OFF'};
    case common.TuyaDataPoints.valveDetection:
        return {valve_detection: value ? 'ON' : 'OFF'};
    case common.TuyaDataPoints.autoLock: // 0x7401 auto lock mode
        return {auto_lock: value ? 'AUTO' : 'MANUAL'};
    case common.TuyaDataPoints.heatingSetpoint:
        return {current_heating_setpoint: parseFloat((value / 10).toFixed(1))};
    case common.TuyaDataPoints.localTemp:
        return {local_temperature: parseFloat((value / 10).toFixed(1))};
    case common.TuyaDataPoints.tempCalibration:
        return {local_temperature_calibration: parseFloat((value / 10).toFixed(1))};
    case common.TuyaDataPoints.battery: // 0x1502 MCU reporting battery status
        return {battery: value};
    case common.TuyaDataPoints.batteryLow:
        return {battery_low: value};
    case common.TuyaDataPoints.minTemp:
        return {min_temperature: value};
    case common.TuyaDataPoints.maxTemp:
        return {max_temperature: value};
    case common.TuyaDataPoints.boostTime: // 0x6902 boost time
        return {boost_time: value};
    case common.TuyaDataPoints.comfortTemp:
        return {comfort_temperature: value};
    case common.TuyaDataPoints.ecoTemp:
        return {eco_temperature: value};
    case common.TuyaDataPoints.valvePos:
        return {position: value};
    case common.TuyaDataPoints.awayTemp:
        return {away_preset_temperature: value};
    case common.TuyaDataPoints.awayDays:
        return {away_preset_days: value};
    case common.TuyaDataPoints.mode: {
        const ret = {};
        const presetOk = utils.getMetaValue(msg.endpoint, model, 'tuyaThermostatPreset').hasOwnProperty(value);
        if (presetOk) {
            ret.preset = utils.getMetaValue(msg.endpoint, model, 'tuyaThermostatPreset')[value];
            ret.away_mode = ret.preset == 'away' ? 'ON' : 'OFF'; // Away is special HA mode
            ret.system_mode = 'heat';
        } else {
            console.log(`TRV preset ${value} is not recognized.`);
            return;
        }
        return ret;
    }
    case common.TuyaDataPoints.fanMode: // fan mode 0 - low , 1 - medium , 2 - high , 3 - auto ( tested on 6dfgetq TUYA zigbee module )
        return {fan_mode: common.TuyaFanModes[value]};
    case common.TuyaDataPoints.forceMode: // force mode 0 - normal, 1 - open, 2 - close
        return {force: common.TuyaThermostatForceMode[value]};
    case common.TuyaDataPoints.weekFormat: // Week select 0 - 5 days, 1 - 6 days, 2 - 7 days
        return {week: common.TuyaThermostatWeekFormat[value]};
    default: // The purpose of the dps 17 & 19 is still unknown
        console.log(`zigbee-herdsman-converters:tuyaThermostat: NOT RECOGNIZED DP #${
            dp} with data ${JSON.stringify(msg.data)}`);
    }
};

const saswellThermostat = (model, msg, publish, options, meta) => {
    const dp = msg.data.dp;
    const value = tuyaGetDataValue(msg.data.datatype, msg.data.data);

    switch (dp) {
    case common.TuyaDataPoints.saswellWindowDetection:
        return {window_detection: value ? 'ON' : 'OFF'};
    case common.TuyaDataPoints.saswellFrostDetection:
        return {frost_detection: value ? 'ON' : 'OFF'};
    case common.TuyaDataPoints.saswellTempCalibration:
        return {local_temperature_calibration: value > 6 ? 0xFFFFFFFF - value : value};
    case common.TuyaDataPoints.saswellChildLock:
        return {child_lock: value ? 'LOCKED' : 'UNLOCKED'};
    case common.TuyaDataPoints.saswellState:
        return {system_mode: value ? 'heat' : 'off'};
    case common.TuyaDataPoints.saswellLocalTemp:
        return {local_temperature: (value / 10).toFixed(1)};
    case common.TuyaDataPoints.saswellHeatingSetpoint:
        return {current_heating_setpoint: (value / 10).toFixed(1)};
    case common.TuyaDataPoints.saswellValvePos:
        // single value 1-100%
        break;
    case common.TuyaDataPoints.saswellBatteryLow:
        return {battery_low: value ? true : false};
    case common.TuyaDataPoints.saswellAwayMode:
        if (value) {
            return {away_mode: 'ON', preset_mode: 'away'};
        } else {
            return {away_mode: 'OFF', preset_mode: 'none'};
        }
    case common.TuyaDataPoints.saswellScheduleMode:
        if (common.TuyaThermostatScheduleMode.hasOwnProperty(value)) {
            return {schedule_mode: common.TuyaThermostatScheduleMode[value]};
        } else {
            meta.logger.warn('zigbee-herdsman-converters:SaswellThermostat: ' +
                `Unknown schedule mode ${value}`);
        }
        break;
    case common.TuyaDataPoints.saswellScheduleEnable:
        if ( value ) {
            return {system_mode: 'auto'};
        }
        break;
    case common.TuyaDataPoints.saswellScheduleSet:
        // Never seen being reported, but put here to prevent warnings
        break;
    case common.TuyaDataPoints.saswellSetpointHistoryDay:
        // 24 values - 1 value for each hour
        break;
    case common.TuyaDataPoints.saswellTimeSync:
        // uint8: year - 2000
        // uint8: month (1-12)
        // uint8: day (1-21)
        // uint8: hour (0-23)
        // uint8: minute (0-59)
        break;
    case common.TuyaDataPoints.saswellSetpointHistoryWeek:
        // 7 values - 1 value for each day
        break;
    case common.TuyaDataPoints.saswellSetpointHistoryMonth:
        // 31 values - 1 value for each day
        break;
    case common.TuyaDataPoints.saswellSetpointHistoryYear:
        // 12 values - 1 value for each month
        break;
    case common.TuyaDataPoints.saswellLocalHistoryDay:
        // 24 values - 1 value for each hour
        break;
    case common.TuyaDataPoints.saswellLocalHistoryWeek:
        // 7 values - 1 value for each day
        break;
    case common.TuyaDataPoints.saswellLocalHistoryMonth:
        // 31 values - 1 value for each day
        break;
    case common.TuyaDataPoints.saswellLocalHistoryYear:
        // 12 values - 1 value for each month
        break;
    case common.TuyaDataPoints.saswellMotorHistoryDay:
        // 24 values - 1 value for each hour
        break;
    case common.TuyaDataPoints.saswellMotorHistoryWeek:
        // 7 values - 1 value for each day
        break;
    case common.TuyaDataPoints.saswellMotorHistoryMonth:
        // 31 values - 1 value for each day
        break;
    case common.TuyaDataPoints.saswellMotorHistoryYear:
        // 12 values - 1 value for each month
        break;
    case common.TuyaDataPoints.saswellScheduleSunday:
    case common.TuyaDataPoints.saswellScheduleMonday:
    case common.TuyaDataPoints.saswellScheduleTuesday:
    case common.TuyaDataPoints.saswellScheduleWednesday:
    case common.TuyaDataPoints.saswellScheduleThursday:
    case common.TuyaDataPoints.saswellScheduleFriday:
    case common.TuyaDataPoints.saswellScheduleSaturday:
        // Handled by tuya_thermostat_weekly_schedule
        // Schedule for each day
        // [
        //     uint8: schedule mode - see above,
        //     uint16: time (60 * hour + minute)
        //     uint16: temperature * 10
        //     uint16: time (60 * hour + minute)
        //     uint16: temperature * 10
        //     uint16: time (60 * hour + minute)
        //     uint16: temperature * 10
        //     uint16: time (60 * hour + minute)
        //     uint16: temperature * 10
        // ]
        break;
    case common.TuyaDataPoints.saswellAntiScaling:
        return {anti_scaling: value ? 'ON' : 'OFF'};
    default:
        meta.logger.warn(`zigbee-herdsman-converters:SaswellThermostat: NOT RECOGNIZED DP #${
            dp} with data ${JSON.stringify(msg.data)}`);
    }
};

const converters = {
    // #region Generic/recommended converters, re-use if possible.
    thermostat: {
        cluster: 'hvacThermostat',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.hasOwnProperty('localTemp')) {
                result[postfixWithEndpointName('local_temperature', msg, model)] = precisionRound(msg.data['localTemp'], 2) / 100;
            }
            if (msg.data.hasOwnProperty('localTemperatureCalibration')) {
                result[postfixWithEndpointName('local_temperature_calibration', msg, model)] =
                    precisionRound(msg.data['localTemperatureCalibration'], 2) / 10;
            }
            if (msg.data.hasOwnProperty('occupancy')) {
                result[postfixWithEndpointName('occupancy', msg, model)] = (msg.data.occupancy % 2) > 0;
            }
            if (msg.data.hasOwnProperty('occupiedHeatingSetpoint')) {
                let value = precisionRound(msg.data['occupiedHeatingSetpoint'], 2) / 100;
                // Stelpro will return -325.65 when set to off, value is not realistic anyway
                value = value < -250 ? 0 : value;
                result[postfixWithEndpointName('occupied_heating_setpoint', msg, model)] = value;
            }
            if (msg.data.hasOwnProperty('unoccupiedHeatingSetpoint')) {
                result[postfixWithEndpointName('unoccupied_heating_setpoint', msg, model)] =
                    precisionRound(msg.data['unoccupiedHeatingSetpoint'], 2) / 100;
            }
            if (msg.data.hasOwnProperty('occupiedCoolingSetpoint')) {
                result[postfixWithEndpointName('occupied_cooling_setpoint', msg, model)] =
                    precisionRound(msg.data['occupiedCoolingSetpoint'], 2) / 100;
            }
            if (msg.data.hasOwnProperty('unoccupiedCoolingSetpoint')) {
                result[postfixWithEndpointName('unoccupied_cooling_setpoint', msg, model)] =
                    precisionRound(msg.data['unoccupiedCoolingSetpoint'], 2) / 100;
            }
            if (msg.data.hasOwnProperty('setpointChangeAmount')) {
                result[postfixWithEndpointName('setpoint_change_amount', msg, model)] = msg.data['setpointChangeAmount'] / 100;
            }
            if (msg.data.hasOwnProperty('setpointChangeSource')) {
                const lookup = {0: 'manual', 1: 'schedule', 2: 'externally'};
                result[postfixWithEndpointName('setpoint_change_source', msg, model)] = lookup[msg.data['setpointChangeSource']];
            }
            if (msg.data.hasOwnProperty('setpointChangeSourceTimeStamp')) {
                const date = new Date(2000, 0, 1);
                date.setSeconds(msg.data['setpointChangeSourceTimeStamp']);
                const value = toLocalISOString(date);
                result[postfixWithEndpointName('setpoint_change_source_timestamp', msg, model)] = value;
            }
            if (msg.data.hasOwnProperty('remoteSensing')) {
                const value = msg.data['remoteSensing'];
                result[postfixWithEndpointName('remote_sensing', msg, model)] = {
                    local_temperature: ((value & 1) > 0) ? 'remotely' : 'internally',
                    outdoor_temperature: ((value & 1<<1) > 0) ? 'remotely' : 'internally',
                    occupancy: ((value & 1<<2) > 0) ? 'remotely' : 'internally',
                };
            }
            if (msg.data.hasOwnProperty('ctrlSeqeOfOper')) {
                result[postfixWithEndpointName('control_sequence_of_operation', msg, model)] =
                    common.thermostatControlSequenceOfOperations[msg.data['ctrlSeqeOfOper']];
            }
            if (msg.data.hasOwnProperty('systemMode')) {
                result[postfixWithEndpointName('system_mode', msg, model)] = common.thermostatSystemModes[msg.data['systemMode']];
            }
            if (msg.data.hasOwnProperty('runningMode')) {
                result[postfixWithEndpointName('running_mode', msg, model)] = common.thermostatRunningMode[msg.data['runningMode']];
            }
            if (msg.data.hasOwnProperty('runningState')) {
                result[postfixWithEndpointName('running_state', msg, model)] = common.thermostatRunningStates[msg.data['runningState']];
            }
            if (msg.data.hasOwnProperty('pIHeatingDemand')) {
                result[postfixWithEndpointName('pi_heating_demand', msg, model)] =
                    precisionRound(msg.data['pIHeatingDemand'] / 255.0 * 100.0, 0);
            }
            if (msg.data.hasOwnProperty('tempSetpointHold')) {
                result[postfixWithEndpointName('temperature_setpoint_hold', msg, model)] = msg.data['tempSetpointHold'] == 1;
            }
            if (msg.data.hasOwnProperty('tempSetpointHoldDuration')) {
                result[postfixWithEndpointName('temperature_setpoint_hold_duration', msg, model)] = msg.data['tempSetpointHoldDuration'];
            }
            return result;
        },
    },
    hvac_user_interface: {
        cluster: 'hvacUserInterfaceCfg',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.hasOwnProperty('keypadLockout')) {
                result.keypad_lockout = msg.data['keypadLockout'] !== 0;
            }
            return result;
        },
    },
    lock_operation_event: {
        cluster: 'closuresDoorLock',
        type: 'commandOperationEventNotification',
        convert: (model, msg, publish, options, meta) => {
            const lookup = {
                0: 'unknown',
                1: 'lock',
                2: 'unlock',
                3: 'lock_failure_invalid_pin_or_id',
                4: 'lock_failure_invalid_schedule',
                5: 'unlock_failure_invalid_pin_or_id',
                6: 'unlock_failure_invalid_schedule',
                7: 'one_touch_lock',
                8: 'key_lock',
                9: 'key_unlock',
                10: 'auto_lock',
                11: 'schedule_lock',
                12: 'schedule_unlock',
                13: 'manual_lock',
                14: 'manual_unlock',
                15: 'non_access_user_operational_event',
            };

            return {
                action: lookup[msg.data['opereventcode']],
                action_user: msg.data['userid'],
                action_source: msg.data['opereventsrc'],
                action_source_name: common.lockSourceName[msg.data['opereventsrc']],
            };
        },
    },
    lock_programming_event: {
        cluster: 'closuresDoorLock',
        type: 'commandProgrammingEventNotification',
        convert: (model, msg, publish, options, meta) => {
            const lookup = {
                0: 'unknown',
                1: 'master_code_changed',
                2: 'pin_code_added',
                3: 'pin_code_deleted',
                4: 'pin_code_changed',
                5: 'rfid_code_added',
                6: 'rfid_code_deleted',
            };
            return {
                action: lookup[msg.data['programeventcode']],
                action_user: msg.data['userid'],
                action_source: msg.data['programeventsrc'],
                action_source_name: common.lockSourceName[msg.data['programeventsrc']],
            };
        },
    },
    lock: {
        cluster: 'closuresDoorLock',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.hasOwnProperty('lockState')) {
                const lookup = {0: 'not_fully_locked', 1: 'locked', 2: 'unlocked'};
                return {
                    state: msg.data.lockState == 1 ? 'LOCK' : 'UNLOCK',
                    lock_state: lookup[msg.data['lockState']],
                };
            }
        },
    },
    lock_pin_code_response: {
        cluster: 'closuresDoorLock',
        type: ['commandGetPinCodeRsp'],
        convert: (model, msg, publish, options, meta) => {
            const {data} = msg;
            let status = '';
            let pinCodeValue = null;
            switch (data.userstatus) {
            case 0:
                status = 'available';
                break;
            case 1:
                status = 'enabled';
                pinCodeValue = data.pincodevalue;
                break;
            case 2:
                status = 'disabled';
                break;
            default:
                status = 'not_supported';
            }
            const userId = data.userid.toString();
            const result = {users: {}};
            result.users[userId] = {status: status};
            if (options && options.expose_pin && pinCodeValue) {
                result.users[userId].pin_code = pinCodeValue;
            }
            return result;
        },
    },
    linkquality_from_basic: {
        cluster: 'genBasic',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            return {linkquality: msg.linkquality};
        },
    },
    battery: {
        cluster: 'genPowerCfg',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const payload = {};
            if (msg.data.hasOwnProperty('batteryPercentageRemaining')) {
                // Some devices do not comply to the ZCL and report a
                // batteryPercentageRemaining of 100 when the battery is full (should be 200).
                const dontDividePercentage = model.meta && model.meta.battery && model.meta.battery.dontDividePercentage;
                let percentage = msg.data['batteryPercentageRemaining'];
                percentage = dontDividePercentage ? percentage : percentage / 2;
                payload.battery = precisionRound(percentage, 2);
            }

            if (msg.data.hasOwnProperty('batteryVoltage')) {
                // Deprecated: voltage is = mV now but should be V
                payload.voltage = msg.data['batteryVoltage'] * 100;

                if (model.meta && model.meta.battery && model.meta.battery.voltageToPercentage) {
                    if (model.meta.battery.voltageToPercentage === '3V_2100') {
                        payload.battery = toPercentage3V(payload.voltage);
                    } else if (model.meta.battery.voltageToPercentage === '3V_2500') {
                        payload.battery = toPercentage(payload.voltage, 2500, 3000);
                    } else if (model.meta.battery.voltageToPercentage === '3V_2500_3200') {
                        payload.battery = toPercentage(payload.voltage, 2500, 3200);
                    }
                }
            }

            if (msg.data.hasOwnProperty('batteryAlarmState')) {
                const battery1Low = (msg.data.batteryAlarmState & 1<<0) > 0;
                const battery2Low = (msg.data.batteryAlarmState & 1<<9) > 0;
                const battery3Low = (msg.data.batteryAlarmState & 1<<19) > 0;
                payload.battery_low = battery1Low || battery2Low || battery3Low;
            }

            return payload;
        },
    },
    temperature: {
        cluster: 'msTemperatureMeasurement',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const temperature = parseFloat(msg.data['measuredValue']) / 100.0;
            const property = postfixWithEndpointName('temperature', msg, model);
            return {[property]: calibrateAndPrecisionRoundOptions(temperature, options, 'temperature')};
        },
    },
    device_temperature: {
        cluster: 'genDeviceTempCfg',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.hasOwnProperty('currentTemperature')) {
                return {device_temperature: parseInt(msg.data['currentTemperature'])};
            }
        },
    },
    humidity: {
        cluster: 'msRelativeHumidity',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const humidity = parseFloat(msg.data['measuredValue']) / 100.0;

            // https://github.com/Koenkk/zigbee2mqtt/issues/798
            // Sometimes the sensor publishes non-realistic vales, it should only publish message
            // in the 0 - 100 range, don't produce messages beyond these values.
            if (humidity >= 0 && humidity <= 100) {
                return {humidity: calibrateAndPrecisionRoundOptions(humidity, options, 'humidity')};
            }
        },
    },
    soil_moisture: {
        cluster: 'msSoilMoisture',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const soilMoisture = parseFloat(msg.data['measuredValue']) / 100.0;
            return {soil_moisture: calibrateAndPrecisionRoundOptions(soilMoisture, options, 'soil_moisture')};
        },
    },
    illuminance: {
        cluster: 'msIlluminanceMeasurement',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            // DEPRECATED: only return lux here (change illuminance_lux -> illuminance)
            const illuminance = msg.data['measuredValue'];
            const illuminanceLux = illuminance === 0 ? 0 : Math.pow(10, (illuminance - 1) / 10000);
            return {
                illuminance: calibrateAndPrecisionRoundOptions(illuminance, options, 'illuminance'),
                illuminance_lux: calibrateAndPrecisionRoundOptions(illuminanceLux, options, 'illuminance_lux'),
            };
        },
    },
    pressure: {
        cluster: 'msPressureMeasurement',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            let pressure = 0;
            if (msg.data.hasOwnProperty('scaledValue')) {
                const scale = msg.endpoint.getClusterAttributeValue('msPressureMeasurement', 'scale');
                pressure = msg.data['scaledValue'] / Math.pow(10, scale) / 100.0; // convert to hPa
            } else {
                pressure = parseFloat(msg.data['measuredValue']);
            }
            return {pressure: calibrateAndPrecisionRoundOptions(pressure, options, 'pressure')};
        },
    },
    co2: {
        cluster: 'msCO2',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            return {co2: Math.floor(msg.data.measuredValue * 1000000)};
        },
    },
    occupancy: {
        // This is for occupancy sensor that send motion start AND stop messages
        cluster: 'msOccupancySensing',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.hasOwnProperty('occupancy')) {
                return {occupancy: (msg.data.occupancy % 2) > 0};
            }
        },
    },
    occupancy_with_timeout: {
        // This is for occupancy sensor that only send a message when motion detected,
        // but do not send a motion stop.
        // Therefore we need to publish the no_motion detected by ourselves.
        cluster: 'msOccupancySensing',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.occupancy !== 1) {
                // In case of 0 no occupancy is reported.
                // https://github.com/Koenkk/zigbee2mqtt/issues/467
                return;
            }

            // The occupancy sensor only sends a message when motion detected.
            // Therefore we need to publish the no_motion detected by ourselves.
            const timeout = options && options.hasOwnProperty('occupancy_timeout') ?
                options.occupancy_timeout : occupancyTimeout;
            const deviceID = msg.device.ieeeAddr;

            // Stop existing timers because motion is detected and set a new one.
            if (store[deviceID]) {
                store[deviceID].forEach((t) => clearTimeout(t));
            }

            store[deviceID] = [];

            if (timeout !== 0) {
                const timer = setTimeout(() => {
                    publish({occupancy: false});
                }, timeout * 1000);

                store[deviceID].push(timer);
            }

            // No occupancy since
            if (options && options.no_occupancy_since) {
                options.no_occupancy_since.forEach((since) => {
                    const timer = setTimeout(() => {
                        publish({no_occupancy_since: since});
                    }, since * 1000);
                    store[deviceID].push(timer);
                });
            }

            if (options && options.no_occupancy_since) {
                return {occupancy: true, no_occupancy_since: 0};
            } else {
                return {occupancy: true};
            }
        },
    },
    occupancy_timeout: {
        cluster: 'msOccupancySensing',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.hasOwnProperty('pirOToUDelay')) {
                return {occupancy_timeout: msg.data.pirOToUDelay};
            }
        },
    },
    brightness: {
        cluster: 'genLevelCtrl',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.hasOwnProperty('currentLevel')) {
                const property = postfixWithEndpointName('brightness', msg, model);
                return {[property]: msg.data['currentLevel']};
            }
        },
    },
    metering_power: {
        /**
         * When using this converter also add the following to the configure method of the device:
         * await readMeteringPowerConverterAttributes(endpoint);
         */
        cluster: 'seMetering',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const payload = {};
            const multiplier = msg.endpoint.getClusterAttributeValue('seMetering', 'multiplier');
            const divisor = msg.endpoint.getClusterAttributeValue('seMetering', 'divisor');
            const factor = multiplier && divisor ? multiplier / divisor : null;

            if (msg.data.hasOwnProperty('instantaneousDemand')) {
                let power = msg.data['instantaneousDemand'];
                if (factor != null) {
                    power = (power * factor) * 1000; // kWh to Watt
                }
                payload.power = precisionRound(power, 2);
            }

            if (factor != null && (msg.data.hasOwnProperty('currentSummDelivered') ||
                msg.data.hasOwnProperty('currentSummReceived'))) {
                let energy = 0;
                if (msg.data.hasOwnProperty('currentSummDelivered')) {
                    const data = msg.data['currentSummDelivered'];
                    const value = (parseInt(data[0]) << 32) + parseInt(data[1]);
                    energy += value * factor;
                }
                if (msg.data.hasOwnProperty('currentSummReceived')) {
                    const data = msg.data['currentSummReceived'];
                    const value = (parseInt(data[0]) << 32) + parseInt(data[1]);
                    energy -= value * factor;
                }
                payload.energy = precisionRound(energy, 2);
            }

            return payload;
        },
    },
    electrical_measurement_power: {
        /**
         * When using this converter also add the following to the configure method of the device:
         * await readEletricalMeasurementConverterAttributes(endpoint);
         */
        cluster: 'haElectricalMeasurement',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const getFactor = (key) => {
                const multiplier = msg.endpoint.getClusterAttributeValue('haElectricalMeasurement', `${key}Multiplier`);
                const divisor = msg.endpoint.getClusterAttributeValue('haElectricalMeasurement', `${key}Divisor`);
                const factor = multiplier && divisor ? multiplier / divisor : 1;
                return factor;
            };

            const lookup = [
                {key: 'activePower', name: 'power', factor: 'acPower'},
                {key: 'activePowerPhB', name: 'power_phase_b', factor: 'acPower'},
                {key: 'activePowerPhC', name: 'power_phase_c', factor: 'acPower'},
                {key: 'rmsCurrent', name: 'current', factor: 'acCurrent'},
                {key: 'rmsCurrentPhB', name: 'current_phase_b', factor: 'acCurrent'},
                {key: 'rmsCurrentPhC', name: 'current_phase_c', factor: 'acCurrent'},
                {key: 'rmsVoltage', name: 'voltage', factor: 'acVoltage'},
                {key: 'rmsVoltagePhB', name: 'voltage_phase_b', factor: 'acVoltage'},
                {key: 'rmsVoltagePhC', name: 'voltage_phase_c', factor: 'acVoltage'},
            ];

            const payload = {};
            for (const entry of lookup) {
                if (msg.data.hasOwnProperty(entry.key)) {
                    const factor = getFactor(entry.factor);
                    const property = postfixWithEndpointName(entry.name, msg, model);
                    payload[property] = precisionRound(msg.data[entry.key] * factor, 2);
                }
            }
            return payload;
        },
    },
    on_off: {
        cluster: 'genOnOff',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.hasOwnProperty('onOff')) {
                const property = postfixWithEndpointName('state', msg, model);
                return {[property]: msg.data['onOff'] === 1 ? 'ON' : 'OFF'};
            }
        },
    },
    on_off_skip_duplicate_transaction: {
        cluster: 'genOnOff',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            // Device sends multiple messages with the same transactionSequenceNumber,
            // prevent that multiple messages get send.
            // https://github.com/Koenkk/zigbee2mqtt/issues/3687
            if (msg.data.hasOwnProperty('onOff') && !hasAlreadyProcessedMessage(msg)) {
                const property = postfixWithEndpointName('state', msg, model);
                return {[property]: msg.data['onOff'] === 1 ? 'ON' : 'OFF'};
            }
        },
    },
    on_off_skip_duplicate_transaction_and_disable_default_response: {
        cluster: 'genOnOff',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.type === 'attributeReport') {
                msg.meta.frameControl.disableDefaultResponse = true;
            }

            if (msg.data.hasOwnProperty('onOff') && !hasAlreadyProcessedMessage(msg)) {
                const property = postfixWithEndpointName('state', msg, model);
                return {[property]: msg.data['onOff'] === 1 ? 'ON' : 'OFF'};
            }
        },
    },
    ias_water_leak_alarm_1: {
        cluster: 'ssIasZone',
        type: 'commandStatusChangeNotification',
        convert: (model, msg, publish, options, meta) => {
            const zoneStatus = msg.data.zonestatus;
            return {
                water_leak: (zoneStatus & 1) > 0,
                tamper: (zoneStatus & 1<<2) > 0,
                battery_low: (zoneStatus & 1<<3) > 0,
            };
        },
    },
    ias_water_leak_alarm_1_report: {
        cluster: 'ssIasZone',
        type: 'attributeReport',
        convert: (model, msg, publish, options, meta) => {
            const zoneStatus = msg.data.zoneStatus;
            return {
                water_leak: (zoneStatus & 1) > 0,
                tamper: (zoneStatus & 1<<2) > 0,
                battery_low: (zoneStatus & 1<<3) > 0,
            };
        },
    },
    ias_vibration_alarm_1: {
        cluster: 'ssIasZone',
        type: 'commandStatusChangeNotification',
        convert: (model, msg, publish, options, meta) => {
            const zoneStatus = msg.data.zonestatus;
            return {
                vibration: (zoneStatus & 1) > 0,
                tamper: (zoneStatus & 1<<2) > 0,
                battery_low: (zoneStatus & 1<<3) > 0,
            };
        },
    },
    ias_gas_alarm_1: {
        cluster: 'ssIasZone',
        type: 'commandStatusChangeNotification',
        convert: (model, msg, publish, options, meta) => {
            const zoneStatus = msg.data.zonestatus;
            return {
                gas: (zoneStatus & 1) > 0,
                tamper: (zoneStatus & 1<<2) > 0,
                battery_low: (zoneStatus & 1<<3) > 0,
            };
        },
    },
    ias_gas_alarm_2: {
        cluster: 'ssIasZone',
        type: 'commandStatusChangeNotification',
        convert: (model, msg, publish, options, meta) => {
            const zoneStatus = msg.data.zonestatus;
            return {
                gas: (zoneStatus & 1<<1) > 0,
                tamper: (zoneStatus & 1<<2) > 0,
                battery_low: (zoneStatus & 1<<3) > 0,
            };
        },
    },
    ias_smoke_alarm_1: {
        cluster: 'ssIasZone',
        type: 'commandStatusChangeNotification',
        convert: (model, msg, publish, options, meta) => {
            const zoneStatus = msg.data.zonestatus;
            const zoneState = msg.data.zoneState;
            return {
                enrolled: zoneState === 1,
                smoke: (zoneStatus & 1) > 0,
                tamper: (zoneStatus & 1<<2) > 0,
                battery_low: (zoneStatus & 1<<3) > 0,
                supervision_reports: (zoneStatus & 1<<4) > 0,
                restore_reports: (zoneStatus & 1<<5) > 0,
                trouble: (zoneStatus & 1<<6) > 0,
                ac_status: (zoneStatus & 1<<7) > 0,
            };
        },
    },
    ias_contact_alarm_1: {
        cluster: 'ssIasZone',
        type: 'commandStatusChangeNotification',
        convert: (model, msg, publish, options, meta) => {
            const zoneStatus = msg.data.zonestatus;
            return {
                contact: !((zoneStatus & 1) > 0),
                tamper: (zoneStatus & 1<<2) > 0,
                battery_low: (zoneStatus & 1<<3) > 0,
            };
        },
    },
    ias_contact_alarm_1_report: {
        cluster: 'ssIasZone',
        type: 'attributeReport',
        convert: (model, msg, publish, options, meta) => {
            const zoneStatus = msg.data.zoneStatus;
            return {
                contact: !((zoneStatus & 1) > 0),
                tamper: (zoneStatus & 1<<2) > 0,
                battery_low: (zoneStatus & 1<<3) > 0,
            };
        },
    },
    ias_carbon_monoxide_alarm_1: {
        cluster: 'ssIasZone',
        type: 'commandStatusChangeNotification',
        convert: (model, msg, publish, options, meta) => {
            const zoneStatus = msg.data.zonestatus;
            return {
                carbon_monoxide: (zoneStatus & 1) > 0,
                tamper: (zoneStatus & 1<<2) > 0,
                battery_low: (zoneStatus & 1<<3) > 0,
            };
        },
    },
    ias_carbon_monoxide_alarm_1_gas_alarm_2: {
        cluster: 'ssIasZone',
        type: 'commandStatusChangeNotification',
        convert: (model, msg, publish, options, meta) => {
            const {zoneStatus} = msg.data;
            return {
                carbon_monoxide: (zoneStatus & 1) > 0,
                gas: (zoneStatus & 1 << 1) > 0,
                tamper: (zoneStatus & 1 << 2) > 0,
                battery_low: (zoneStatus & 1 << 3) > 0,
                trouble: (zoneStatus & 1 << 6) > 0,
                ac_connected: !((zoneStatus & 1 << 7) > 0),
                test: (zoneStatus & 1 << 8) > 0,
                battery_defect: (zoneStatus & 1 << 9) > 0,
            };
        },
    },
    ias_sos_alarm_2: {
        cluster: 'ssIasZone',
        type: 'commandStatusChangeNotification',
        convert: (model, msg, publish, options, meta) => {
            const zoneStatus = msg.data.zonestatus;
            return {
                sos: (zoneStatus & 1<<1) > 0,
                tamper: (zoneStatus & 1<<2) > 0,
                battery_low: (zoneStatus & 1<<3) > 0,
            };
        },
    },
    ias_occupancy_alarm_1: {
        cluster: 'ssIasZone',
        type: 'commandStatusChangeNotification',
        convert: (model, msg, publish, options, meta) => {
            const zoneStatus = msg.data.zonestatus;
            return {
                occupancy: (zoneStatus & 1) > 0,
                tamper: (zoneStatus & 1<<2) > 0,
                battery_low: (zoneStatus & 1<<3) > 0,
            };
        },
    },
    ias_occupancy_alarm_2: {
        cluster: 'ssIasZone',
        type: 'commandStatusChangeNotification',
        convert: (model, msg, publish, options, meta) => {
            const zoneStatus = msg.data.zonestatus;
            return {
                occupancy: (zoneStatus & 1<<1) > 0,
                tamper: (zoneStatus & 1<<2) > 0,
                battery_low: (zoneStatus & 1<<3) > 0,
            };
        },
    },
    ias_occupancy_alarm_1_with_timeout: {
        cluster: 'ssIasZone',
        type: 'commandStatusChangeNotification',
        convert: (model, msg, publish, options, meta) => {
            const zoneStatus = msg.data.zonestatus;
            const deviceID = msg.device.ieeeAddr;
            const timeout = options && options.hasOwnProperty('occupancy_timeout') ?
                options.occupancy_timeout : occupancyTimeout;

            if (store[deviceID]) {
                clearTimeout(store[deviceID]);
                store[deviceID] = null;
            }

            if (timeout !== 0) {
                store[deviceID] = setTimeout(() => {
                    publish({occupancy: false});
                    store[deviceID] = null;
                }, timeout * 1000);
            }

            return {
                occupancy: (zoneStatus & 1) > 0,
                tamper: (zoneStatus & 1<<2) > 0,
                battery_low: (zoneStatus & 1<<3) > 0,
            };
        },
    },
    command_recall: {
        cluster: 'genScenes',
        type: 'commandRecall',
        convert: (model, msg, publish, options, meta) => {
            const payload = {action: postfixWithEndpointName(`recall_${msg.data.sceneid}`, msg, model)};
            addActionGroup(payload, msg, model);
            return payload;
        },
    },
    command_panic: {
        cluster: 'ssIasAce',
        type: 'commandPanic',
        convert: (model, msg, publish, options, meta) => {
            const payload = {action: postfixWithEndpointName(`panic`, msg, model)};
            addActionGroup(payload, msg, model);
            return payload;
        },
    },
    command_arm: {
        cluster: 'ssIasAce',
        type: 'commandArm',
        convert: (model, msg, publish, options, meta) => {
            if (hasAlreadyProcessedMessage(msg)) return;
            const payload = {
                action: postfixWithEndpointName(common.armMode[msg.data['armmode']], msg, model),
                action_code: msg.data.code,
                action_zone: msg.data.zoneid,
            };
            if (model.meta && model.meta.commandArmIncludeTransaction) {
                payload.action_transaction = msg.meta.zclTransactionSequenceNumber;
            }
            if (msg.groupID) payload.action_group = msg.groupID;
            return payload;
        },
    },
    command_cover_stop: {
        cluster: 'closuresWindowCovering',
        type: 'commandStop',
        convert: (model, msg, publish, options, meta) => {
            const payload = {action: postfixWithEndpointName('stop', msg, model)};
            addActionGroup(payload, msg, model);
            return payload;
        },
    },
    command_cover_open: {
        cluster: 'closuresWindowCovering',
        type: 'commandUpOpen',
        convert: (model, msg, publish, options, meta) => {
            const payload = {action: postfixWithEndpointName('open', msg, model)};
            addActionGroup(payload, msg, model);
            return payload;
        },
    },
    command_cover_close: {
        cluster: 'closuresWindowCovering',
        type: 'commandDownClose',
        convert: (model, msg, publish, options, meta) => {
            const payload = {action: postfixWithEndpointName('close', msg, model)};
            addActionGroup(payload, msg, model);
            return payload;
        },
    },
    command_on: {
        cluster: 'genOnOff',
        type: 'commandOn',
        convert: (model, msg, publish, options, meta) => {
            const payload = {action: postfixWithEndpointName('on', msg, model)};
            addActionGroup(payload, msg, model);
            return payload;
        },
    },
    command_off: {
        cluster: 'genOnOff',
        type: 'commandOff',
        convert: (model, msg, publish, options, meta) => {
            const payload = {action: postfixWithEndpointName('off', msg, model)};
            addActionGroup(payload, msg, model);
            return payload;
        },
    },
    command_off_with_effect: {
        cluster: 'genOnOff',
        type: 'commandOffWithEffect',
        convert: (model, msg, publish, options, meta) => {
            const payload = {action: postfixWithEndpointName(`off`, msg, model)};
            addActionGroup(payload, msg, model);
            return payload;
        },
    },
    command_toggle: {
        cluster: 'genOnOff',
        type: 'commandToggle',
        convert: (model, msg, publish, options, meta) => {
            const payload = {action: postfixWithEndpointName('toggle', msg, model)};
            addActionGroup(payload, msg, model);
            return payload;
        },
    },
    command_move_to_level: {
        cluster: 'genLevelCtrl',
        type: ['commandMoveToLevel', 'commandMoveToLevelWithOnOff'],
        convert: (model, msg, publish, options, meta) => {
            const payload = {
                action: postfixWithEndpointName(`brightness_move_to_level`, msg, model),
                action_level: msg.data.level,
                action_transition_time: msg.data.transtime / 100,
            };
            addActionGroup(payload, msg, model);

            if (options.simulated_brightness) {
                globalStore.putValue(msg.endpoint, 'simulated_brightness_brightness', msg.data.level);
                payload.brightness = msg.data.level;
            }

            return payload;
        },
    },
    command_move: {
        cluster: 'genLevelCtrl',
        type: ['commandMove', 'commandMoveWithOnOff'],
        convert: (model, msg, publish, options, meta) => {
            const direction = msg.data.movemode === 1 ? 'down' : 'up';
            const action = postfixWithEndpointName(`brightness_move_${direction}`, msg, model);
            const payload = {action, action_rate: msg.data.rate};
            addActionGroup(payload, msg, model);

            if (options.simulated_brightness) {
                const opts = options.simulated_brightness;
                const deltaOpts = typeof opts === 'object' && opts.hasOwnProperty('delta') ? opts.delta : 20;
                const intervalOpts = typeof opts === 'object' && opts.hasOwnProperty('interval') ? opts.interval : 200;

                globalStore.putValue(msg.endpoint, 'simulated_brightness_direction', direction);
                if (globalStore.getValue(msg.endpoint, 'simulated_brightness_timer') === undefined) {
                    const timer = setInterval(() => {
                        let brightness = globalStore.getValue(msg.endpoint, 'simulated_brightness_brightness', 255);
                        const delta = globalStore.getValue(msg.endpoint, 'simulated_brightness_direction') === 'up' ?
                            deltaOpts : -1 * deltaOpts;
                        brightness += delta;
                        brightness = numberWithinRange(brightness, 0, 255);
                        globalStore.putValue(msg.endpoint, 'simulated_brightness_brightness', brightness);
                        publish({brightness});
                    }, intervalOpts);

                    globalStore.putValue(msg.endpoint, 'simulated_brightness_timer', timer);
                }
            }

            return payload;
        },
    },
    command_step: {
        cluster: 'genLevelCtrl',
        type: ['commandStep', 'commandStepWithOnOff'],
        convert: (model, msg, publish, options, meta) => {
            const direction = msg.data.stepmode === 1 ? 'down' : 'up';
            const payload = {
                action: postfixWithEndpointName(`brightness_step_${direction}`, msg, model),
                action_step_size: msg.data.stepsize,
                action_transition_time: msg.data.transtime / 100,
            };
            addActionGroup(payload, msg, model);

            if (options.simulated_brightness) {
                let brightness = globalStore.getValue(msg.endpoint, 'simulated_brightness_brightness', 255);
                const delta = direction === 'up' ? msg.data.stepsize : -1 * msg.data.stepsize;
                brightness += delta;
                brightness = numberWithinRange(brightness, 0, 255);
                globalStore.putValue(msg.endpoint, 'simulated_brightness_brightness', brightness);
                payload.brightness = brightness;
            }

            return payload;
        },
    },
    command_stop: {
        cluster: 'genLevelCtrl',
        type: ['commandStop', 'commandStopWithOnOff'],
        convert: (model, msg, publish, options, meta) => {
            if (options.simulated_brightness) {
                clearInterval(globalStore.getValue(msg.endpoint, 'simulated_brightness_timer'));
                globalStore.putValue(msg.endpoint, 'simulated_brightness_timer', undefined);
            }

            const payload = {action: postfixWithEndpointName(`brightness_stop`, msg, model)};
            addActionGroup(payload, msg, model);
            return payload;
        },
    },
    command_step_color_temperature: {
        cluster: 'lightingColorCtrl',
        type: 'commandStepColorTemp',
        convert: (model, msg, publish, options, meta) => {
            const direction = msg.data.stepmode === 1 ? 'up' : 'down';
            const payload = {
                action: postfixWithEndpointName(`color_temperature_step_${direction}`, msg, model),
                action_step_size: msg.data.stepsize,
            };

            if (msg.data.hasOwnProperty('transtime')) {
                payload.action_transition_time = msg.data.transtime / 100;
            }

            addActionGroup(payload, msg, model);
            return payload;
        },
    },
    command_ehanced_move_to_hue_and_saturation: {
        cluster: 'lightingColorCtrl',
        type: 'commandEnhancedMoveToHueAndSaturation',
        convert: (model, msg, publish, options, meta) => {
            const payload = {
                action: postfixWithEndpointName(`enhanced_move_to_hue_and_saturation`, msg, model),
                action_enhanced_hue: msg.data.enhancehue,
                action_hue: msg.data.enhancehue * 360 / 65536 % 360,
                action_saturation: msg.data.saturation,
                action_transition_time: msg.data.transtime,
            };

            addActionGroup(payload, msg, model);
            return payload;
        },
    },
    command_step_hue: {
        cluster: 'lightingColorCtrl',
        type: ['commandStepHue'],
        convert: (model, msg, publish, options, meta) => {
            const direction = msg.data.stepmode === 1 ? 'up' : 'down';
            const payload = {
                action: postfixWithEndpointName(`color_hue_step_${direction}`, msg, model),
                action_step_size: msg.data.stepsize,
                action_transition_time: msg.data.transtime/100,
            };
            addActionGroup(payload, msg, model);
            return payload;
        },
    },
    command_step_saturation: {
        cluster: 'lightingColorCtrl',
        type: ['commandStepSaturation'],
        convert: (model, msg, publish, options, meta) => {
            const direction = msg.data.stepmode === 1 ? 'up' : 'down';
            const payload = {
                action: postfixWithEndpointName(`color_saturation_step_${direction}`, msg, model),
                action_step_size: msg.data.stepsize,
                action_transition_time: msg.data.transtime/100,
            };
            addActionGroup(payload, msg, model);
            return payload;
        },
    },
    command_color_loop_set: {
        cluster: 'lightingColorCtrl',
        type: 'commandColorLoopSet',
        convert: (model, msg, publish, options, meta) => {
            const updateFlags = msg.data.updateflags;
            const actionLookup = {
                0x00: 'deactivate',
                0x01: 'activate_from_color_loop_start_enhanced_hue',
                0x02: 'activate_from_enhanced_current_hue',
            };

            const payload = {
                action: postfixWithEndpointName(`color_loop_set`, msg, model),
                action_update_flags: {
                    action: (updateFlags & 1 << 0) > 0,
                    direction: (updateFlags & 1 << 1) > 0,
                    time: (updateFlags & 1 << 2) > 0,
                    start_hue: (updateFlags & 1 << 3) > 0,
                },
                action_action: actionLookup[msg.data.action],
                action_direction: msg.data.direction === 0 ? 'decrement' : 'increment',
                action_time: msg.data.time,
                action_start_hue: msg.data.starthue,
            };

            addActionGroup(payload, msg, model);
            return payload;
        },
    },
    command_move_to_color_temp: {
        cluster: 'lightingColorCtrl',
        type: 'commandMoveToColorTemp',
        convert: (model, msg, publish, options, meta) => {
            const payload = {
                action: postfixWithEndpointName(`color_temperature_move`, msg, model),
                action_color_temperature: msg.data.colortemp,
                action_transition_time: msg.data.transtime,
            };
            addActionGroup(payload, msg, model);
            return payload;
        },
    },
    command_move_to_color: {
        cluster: 'lightingColorCtrl',
        type: 'commandMoveToColor',
        convert: (model, msg, publish, options, meta) => {
            const payload = {
                action: postfixWithEndpointName(`color_move`, msg, model),
                action_color: {
                    x: precisionRound(msg.data.colorx / 65535, 3),
                    y: precisionRound(msg.data.colory / 65535, 3),
                },
                action_transition_time: msg.data.transtime,
            };
            addActionGroup(payload, msg, model);
            return payload;
        },
    },
    command_move_hue: {
        cluster: 'lightingColorCtrl',
        type: 'commandMoveHue',
        convert: (model, msg, publish, options, meta) => {
            const payload = {action: postfixWithEndpointName('hue_move', msg, model)};
            addActionGroup(payload, msg, model);
            return payload;
        },
    },
    command_move_to_saturation: {
        cluster: 'lightingColorCtrl',
        type: 'commandMoveToSaturation',
        convert: (model, msg, publish, options, meta) => {
            const payload = {
                action: postfixWithEndpointName('move_to_saturation', msg, model),
                action_saturation: msg.data.saturation,
                action_transition_time: msg.data.transtime,
            };
            addActionGroup(payload, msg, model);
            return payload;
        },
    },
    command_emergency: {
        cluster: 'ssIasAce',
        type: 'commandEmergency',
        convert: (model, msg, publish, options, meta) => {
            if (hasAlreadyProcessedMessage(msg)) return;
            const payload = {action: postfixWithEndpointName(`emergency`, msg, model)};
            addActionGroup(payload, msg, model);
            return payload;
        },
    },
    command_on_state: {
        cluster: 'genOnOff',
        type: 'commandOn',
        convert: (model, msg, publish, options, meta) => {
            const property = postfixWithEndpointName('state', msg, model);
            return {[property]: 'ON'};
        },
    },
    command_off_state: {
        cluster: 'genOnOff',
        type: 'commandOff',
        convert: (model, msg, publish, options, meta) => {
            const property = postfixWithEndpointName('state', msg, model);
            return {[property]: 'OFF'};
        },
    },
    identify: {
        cluster: 'genIdentify',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            return {action: postfixWithEndpointName(`identify`, msg, model)};
        },
    },
    cover_position_tilt: {
        cluster: 'closuresWindowCovering',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            // Zigbee officially expects 'open' to be 0 and 'closed' to be 100 whereas
            // HomeAssistant etc. work the other way round.
            // For zigbee-herdsman-converters: open = 100, close = 0
            // ubisys J1 will report 255 if lift or tilt positions are not known, so skip that.
            const invert = model.meta && model.meta.coverInverted ? !options.invert_cover : options.invert_cover;
            if (msg.data.hasOwnProperty('currentPositionLiftPercentage') && msg.data['currentPositionLiftPercentage'] <= 100) {
                const value = msg.data['currentPositionLiftPercentage'];
                result.position = invert ? value : 100 - value;
            }
            if (msg.data.hasOwnProperty('currentPositionTiltPercentage') && msg.data['currentPositionTiltPercentage'] <= 100) {
                const value = msg.data['currentPositionTiltPercentage'];
                result.tilt = invert ? value : 100 - value;
            }
            return result;
        },
    },
    cover_position_via_brightness: {
        cluster: 'genLevelCtrl',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const currentLevel = msg.data['currentLevel'];
            let position = Math.round(Number(currentLevel) / 2.55).toString();
            position = options.invert_cover ? 100 - position : position;
            const state = options.invert_cover ? (position > 0 ? 'CLOSE' : 'OPEN') : (position > 0 ? 'OPEN' : 'CLOSE');
            return {state: state, position: position};
        },
    },
    cover_state_via_onoff: {
        cluster: 'genOnOff',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.hasOwnProperty('onOff')) {
                return {state: msg.data['onOff'] === 1 ? 'OPEN' : 'CLOSE'};
            }
        },
    },
    curtain_position_analog_output: {
        cluster: 'genAnalogOutput',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            let position = precisionRound(msg.data['presentValue'], 2);
            position = options.invert_cover ? 100 - position : position;
            return {position};
        },
    },
    // #endregion

    // #region Non-generic converters, re-use if possible
    sinope_thermostat: {
        cluster: 'hvacThermostat',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = converters.thermostat.convert(model, msg, publish, options, meta);
            // Sinope seems to report pIHeatingDemand between 0 and 100 already
            if (msg.data.hasOwnProperty('pIHeatingDemand')) {
                result.pi_heating_demand = precisionRound(msg.data['pIHeatingDemand'], 0);
            }
            return result;
        },
    },
    stelpro_thermostat: {
        cluster: 'hvacThermostat',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = converters.thermostat.convert(model, msg, publish, options, meta);
            if (msg.data['StelproSystemMode'] === 5) {
                // 'Eco' mode is translated into 'auto' here
                result.system_mode = common.thermostatSystemModes[1];
            }
            if (msg.data.hasOwnProperty('pIHeatingDemand')) {
                result.running_state = msg.data['pIHeatingDemand'] >= 10 ? 'heat' : 'idle';
            }
            return result;
        },
    },
    viessmann_thermostat: {
        cluster: 'hvacThermostat',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = converters.thermostat.convert(model, msg, publish, options, meta);
            // ViessMann TRVs report piHeatingDemand from 0-5
            // NOTE: remove the result for now, but leave it configure for reporting
            //       it will show up in the debug log still to help try and figure out
            //       what this value potentially means.
            delete result.pi_heating_demand;
            return result;
        },
    },
    ZigUP_parse: {
        cluster: 'genOnOff',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const lookup = {
                '0': 'timer',
                '1': 'key',
                '2': 'dig-in',
            };

            let ds18b20Id = null;
            let ds18b20Value = null;
            if (msg.data['41368']) {
                ds18b20Id = msg.data['41368'].split(':')[0];
                ds18b20Value = precisionRound(msg.data['41368'].split(':')[1], 2);
            }

            return {
                state: msg.data['onOff'] === 1 ? 'ON' : 'OFF',
                cpu_temperature: precisionRound(msg.data['41361'], 2),
                external_temperature: precisionRound(msg.data['41362'], 1),
                external_humidity: precisionRound(msg.data['41363'], 1),
                s0_counts: msg.data['41364'],
                adc_volt: precisionRound(msg.data['41365'], 3),
                dig_input: msg.data['41366'],
                reason: lookup[msg.data['41367']],
                [`${ds18b20Id}`]: ds18b20Value,
            };
        },
    },
    eurotronic_thermostat: {
        cluster: 'hvacThermostat',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = converters.thermostat.convert(model, msg, publish, options, meta);
            // system_mode is always 'heat', we set it below based on eurotronic_host_flags
            delete result['system_mode'];

            if (typeof msg.data[0x4003] == 'number') {
                result.current_heating_setpoint = precisionRound(msg.data[0x4003], 2) / 100;
            }
            if (typeof msg.data[0x4008] == 'number') {
                result.child_protection = (result.eurotronic_host_flags & (1 << 7)) != 0;
                result.mirror_display = (result.eurotronic_host_flags & (1 << 1)) != 0;
                result.boost = (result.eurotronic_host_flags & 1 << 2) != 0;
                result.window_open = (result.eurotronic_host_flags & (1 << 4)) != 0;

                if (result.boost) result.system_mode = common.thermostatSystemModes[4];
                else if (result.window_open) result.system_mode = common.thermostatSystemModes[0];
                else result.system_mode = common.thermostatSystemModes[1];
            }
            if (typeof msg.data[0x4002] == 'number') {
                result.error_status = msg.data[0x4002];
            }
            if (typeof msg.data[0x4000] == 'number') {
                result.trv_mode = msg.data[0x4000];
            }
            if (typeof msg.data[0x4001] == 'number') {
                result.valve_position = msg.data[0x4001];
            }
            return result;
        },
    },
    neo_t_h_alarm: {
        cluster: 'manuSpecificTuya',
        type: ['commandSetDataResponse', 'commandGetData'],
        convert: (model, msg, publish, options, meta) => {
            const dp = msg.data.dp;
            const value = tuyaGetDataValue(msg.data.datatype, msg.data.data);

            switch (dp) {
            case common.TuyaDataPoints.neoAlarm:
                return {alarm: value};
            case common.TuyaDataPoints.neoUnknown2: // 0x0170 [0]
                break;
            case common.TuyaDataPoints.neoTempAlarm:
                return {temperature_alarm: value};
            case common.TuyaDataPoints.neoHumidityAlarm: // 0x0172 [0]/[1] Disable/Enable alarm by humidity
                return {humidity_alarm: value};
            case common.TuyaDataPoints.neoDuration: // 0x0267 [0,0,0,10] duration alarm in second
                return {duration: value};
            case common.TuyaDataPoints.neoTemp: // 0x0269 [0,0,0,240] temperature
                return {temperature: (value / 10).toFixed(1)};
            case common.TuyaDataPoints.neoHumidity: // 0x026A [0,0,0,36] humidity
                return {humidity: value};
            case common.TuyaDataPoints.neoMinTemp: // 0x026B [0,0,0,18] min alarm temperature
                return {temperature_min: value};
            case common.TuyaDataPoints.neoMaxTemp: // 0x026C [0,0,0,27] max alarm temperature
                return {temperature_max: value};
            case common.TuyaDataPoints.neoMinHumidity: // 0x026D [0,0,0,45] min alarm humidity
                return {humidity_min: value};
            case common.TuyaDataPoints.neoMaxHumidity: // 0x026E [0,0,0,80] max alarm humidity
                return {humidity_max: value};
            case common.TuyaDataPoints.neoUnknown1: // 0x0465 [4]
                break;
            case common.TuyaDataPoints.neoMelody: // 0x0466 [5] Melody
                return {melody: value};
            case common.TuyaDataPoints.neoUnknown3: // 0x0473 [0]
                break;
            case common.TuyaDataPoints.neoVolume: // 0x0474 [0]/[1]/[2] Volume 0-max, 2-low
                return {volume: {2: 'low', 1: 'medium', 0: 'high'}[value]};
            default: // Unknown code
                meta.logger.warn(`Unhandled DP #${dp}: ${JSON.stringify(msg.data)}`);
            }
        },
    },
    terncy_contact: {
        cluster: 'genBinaryInput',
        type: 'attributeReport',
        convert: (model, msg, publish, options, meta) => {
            return {contact: (msg.data['presentValue']==0)};
        },
    },
    terncy_temperature: {
        cluster: 'msTemperatureMeasurement',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const temperature = parseFloat(msg.data['measuredValue']) / 10.0;
            return {temperature: calibrateAndPrecisionRoundOptions(temperature, options, 'temperature')};
        },
    },
    ts0216_siren: {
        cluster: 'ssIasWd',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.hasOwnProperty('maxDuration')) result['duration'] = msg.data.maxDuration;
            if (msg.data.hasOwnProperty('2')) result['volume'] = msg.data['2'];
            if (msg.data.hasOwnProperty('61440')) {
                result['alarm'] = (msg.data['61440'] == 0) ? false : true;
            }
            return result;
        },
    },
    tuya_cover_options: {
        cluster: 'closuresWindowCovering',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.hasOwnProperty('tuyaMovingState')) {
                const value = msg.data['tuyaMovingState'];
                const movingLookup = {0: 'UP', 1: 'STOP', 2: 'DOWN'};
                result.moving = movingLookup[value];
            }
            if (msg.data.hasOwnProperty('tuyaCalibration')) {
                const value = msg.data['tuyaCalibration'];
                const calibrationLookup = {0: 'ON', 1: 'OFF'};
                result.calibration = calibrationLookup[value];
            }
            if (msg.data.hasOwnProperty('tuyaMotorReversal')) {
                const value = msg.data['tuyaMotorReversal'];
                const reversalLookup = {0: 'OFF', 1: 'ON'};
                result.motor_reversal = reversalLookup[value];
            }
            return result;
        },
    },
    tuya_backlight_mode: {
        cluster: 'genOnOff',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.hasOwnProperty('tuyaBacklightMode')) {
                const value = msg.data['tuyaBacklightMode'];
                const backlightLookup = {0: 'LOW', 1: 'MEDIUM', 2: 'HIGH'};
                return {backlight_mode: backlightLookup[value]};
            }
        },
    },
    tuya_on_off_action: {
        cluster: 'genOnOff',
        type: 'raw',
        convert: (model, msg, publish, options, meta) => {
            if (hasAlreadyProcessedMessage(msg, msg.data[1])) return;
            const clickMapping = {0: 'single', 1: 'double', 2: 'hold'};
            let buttonMapping = null;
            if (model.model === 'TS0042') {
                buttonMapping = {1: '1', 2: '2'};
            } else if (model.model === 'TS0043') {
                buttonMapping = {1: '1', 2: '2', 3: '3'};
            } else if (model.model === 'TS0044') {
                buttonMapping = {1: '1', 2: '2', 3: '3', 4: '4'};
            }
            const button = buttonMapping ? `${buttonMapping[msg.endpoint.ID]}_` : '';
            return {action: `${button}${clickMapping[msg.data[3]]}`};
        },
    },
    tuya_water_leak: {
        cluster: 'manuSpecificTuya',
        type: 'commandSetDataResponse',
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.dp === common.TuyaDataPoints.waterLeak) {
                return {water_leak: tuyaGetDataValue(msg.data.datatype, msg.data.data)};
            }
        },
    },
    livolo_switch_state: {
        cluster: 'genOnOff',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const status = msg.data.onOff;
            return {
                state_left: status & 1 ? 'ON' : 'OFF',
                state_right: status & 2 ? 'ON' : 'OFF',
            };
        },
    },
    livolo_socket_state: {
        cluster: 'genPowerCfg',
        type: ['raw'],
        convert: (model, msg, publish, options, meta) => {
            const stateHeader = Buffer.from([122, 209]);
            if (msg.data.indexOf(stateHeader) === 0) {
                const status = msg.data[14];
                return {state: status & 1 ? 'ON' : 'OFF'};
            }
        },
    },
    livolo_new_switch_state: {
        cluster: 'genPowerCfg',
        type: ['raw'],
        convert: (model, msg, publish, options, meta) => {
            const stateHeader = Buffer.from([122, 209]);
            if (msg.data.indexOf(stateHeader) === 0) {
                const status = msg.data[14];
                return {state: status & 1 ? 'ON' : 'OFF'};
            }
        },
    },
    livolo_switch_state_raw: {
        cluster: 'genPowerCfg',
        type: ['raw'],
        convert: (model, msg, publish, options, meta) => {
            /*
            header                ieee address            info data
            new socket
            [124,210,21,216,128,  199,147,3,24,0,75,18,0,  19,7,0]       after interview
            [122,209,             199,147,3,24,0,75,18,0,  7,1,6,1,0,11] off
            [122,209,             199,147,3,24,0,75,18,0,  7,1,6,1,1,11] on
            new switch
            [124,210,21,216,128,  228,41,3,24,0,75,18,0,  19,1,0]       after interview
            [122,209,             228,41,3,24,0,75,18,0,  7,1,0,1,0,11] off
            [122,209,             228,41,3,24,0,75,18,0,  7,1,0,1,1,11] on
            old switch
            [124,210,21,216,128,  170, 10,2,24,0,75,18,0,  17,0,1] after interview
            [124,210,21,216,0,     18, 15,5,24,0,75,18,0,  34,0,0] left: 0, right: 0
            [124,210,21,216,0,     18, 15,5,24,0,75,18,0,  34,0,1] left: 1, right: 0
            [124,210,21,216,0,     18, 15,5,24,0,75,18,0,  34,0,2] left: 0, right: 1
            [124,210,21,216,0,     18, 15,5,24,0,75,18,0,  34,0,3] left: 1, right: 1
            */
            const malformedHeader = Buffer.from([0x7c, 0xd2, 0x15, 0xd8, 0x00]);
            const infoHeader = Buffer.from([0x7c, 0xd2, 0x15, 0xd8, 0x80]);
            // status of old devices
            if (msg.data.indexOf(malformedHeader) === 0) {
                const status = msg.data[15];
                return {
                    state_left: status & 1 ? 'ON' : 'OFF',
                    state_right: status & 2 ? 'ON' : 'OFF',
                };
            }
            // info about device
            if (msg.data.indexOf(infoHeader) === 0) {
                if (msg.data.includes(Buffer.from([19, 7, 0]), 13)) {
                    // new socket, hack
                    meta.device.modelID = 'TI0001-socket';
                    meta.device.save();
                }
                if (msg.data.includes(Buffer.from([19, 1, 0]), 13)) {
                    // new switch, hack
                    meta.device.modelID = 'TI0001-switch';
                    meta.device.save();
                }
            }
        },
    },
    hy_set_time_request: {
        cluster: 'manuSpecificTuya',
        type: ['commandSetTimeRequest'],
        convert: async (model, msg, publish, options, meta) => {
            const OneJanuary2000 = new Date('January 01, 2000 00:00:00 UTC+00:00').getTime();
            const currentTime = new Date().getTime();
            const utcTime = Math.round((currentTime - OneJanuary2000) / 1000);
            const localTime = Math.round(currentTime / 1000) - (new Date()).getTimezoneOffset() * 60;
            const endpoint = msg.device.getEndpoint(1);
            const payload = {
                payloadSize: 8,
                payload: [
                    ...utils.convertDecimalValueTo4ByteHexArray(utcTime),
                    ...utils.convertDecimalValueTo4ByteHexArray(localTime),
                ],
            };
            await endpoint.command('manuSpecificTuya', 'setTime', payload, {});
        },
    },
    ptvo_switch_uart: {
        cluster: 'genMultistateValue',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            let data = msg.data['stateText'];
            if (typeof data === 'object') {
                let bHex = false;
                let code;
                let index;
                for (index = 0; index < data.length; index += 1) {
                    code = data[index];
                    if ((code < 32) || (code > 127)) {
                        bHex = true;
                        break;
                    }
                }
                if (!bHex) {
                    data = data.toString('latin1');
                } else {
                    data = [...data];
                }
            }
            return {'action': data};
        },
    },
    ptvo_switch_analog_input: {
        cluster: 'genAnalogInput',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const payload = {};
            const channel = msg.endpoint.ID;
            const name = `l${channel}`;
            payload[name] = precisionRound(msg.data['presentValue'], 3);
            if (msg.data.hasOwnProperty('description')) {
                const data1 = msg.data['description'];
                if (data1) {
                    const data2 = data1.split(',');
                    const devid = data2[1];
                    const unit = data2[0];
                    if (devid) {
                        payload['device_' + name] = devid;
                    }

                    const valRaw = msg.data['presentValue'];
                    if (unit) {
                        let val = precisionRound(valRaw, 1);

                        const nameLookup = {
                            'C': 'temperature',
                            '%': 'humidity',
                            'm': 'altitude',
                            'Pa': 'pressure',
                            'ppm': 'quality',
                            'psize': 'particle_size',
                            'V': 'voltage',
                            'A': 'current',
                            'Wh': 'energy',
                            'W': 'power',
                            'Hz': 'frequency',
                            'pf': 'power_factor',
                            'lx': 'illuminance_lux',
                        };

                        let nameAlt = '';
                        if (unit === 'A') {
                            if (valRaw < 1) {
                                val = precisionRound(valRaw, 3);
                            }
                        }
                        if (unit.startsWith('mcpm') || unit.startsWith('ncpm')) {
                            const num = unit.substr(4, 1);
                            nameAlt = (num === 'A')? unit.substr(0, 4) + '10': unit;
                            val = precisionRound(valRaw, 2);
                        } else {
                            nameAlt = nameLookup[unit];
                        }
                        if (nameAlt === undefined) {
                            const valueIndex = parseInt(unit, 10);
                            if (! isNaN(valueIndex)) {
                                nameAlt = 'val' + unit;
                            }
                        }

                        if (nameAlt !== undefined) {
                            payload[nameAlt + '_' + name] = val;
                        }
                    }
                }
            }
            return payload;
        },
    },
    keypad20states: {
        cluster: 'genOnOff',
        type: ['readResponse', 'attributeReport'],
        convert: (model, msg, publish, options, meta) => {
            const button = getKey(model.endpoint(msg.device), msg.endpoint.ID);
            const state = msg.data['onOff'] === 1 ? true : false;
            if (button) {
                return {[button]: state};
            }
        },
    },
    keypad20_battery: {
        cluster: 'genPowerCfg',
        type: ['readResponse', 'attributeReport'],
        convert: (model, msg, publish, options, meta) => {
            const battery = {max: 3000, min: 2100};
            const voltage = msg.data['mainsVoltage'] /10;
            return {
                battery: toPercentage(voltage, battery.min, battery.max),
                voltage: voltage, // @deprecated
                // voltage: voltage / 1000.0,
            };
        },
    },
    silvercrest_smart_led_string: {
        cluster: 'manuSpecificTuya',
        type: ['commandGetData', 'commandSetDataResponse'],
        convert: (model, msg, publish, options, meta) => {
            const dp = msg.data.dp;
            const value = tuyaGetDataValue(msg.data.datatype, msg.data.data);
            const result = {};

            if (dp === common.TuyaDataPoints.silvercrestChangeMode) {
                if (value !== common.silvercrestModes.effect) {
                    result.effect = null;
                }
            } if (dp === common.TuyaDataPoints.silvercrestSetBrightness) {
                result.brightness = (value / 1000) * 255;
            } else if (dp === common.TuyaDataPoints.silvercrestSetColor) {
                const h = parseInt(value.substring(0, 4), 16);
                const s = parseInt(value.substring(4, 8), 16);
                const b = parseInt(value.substring(8, 12), 16);
                result.color = {b: (b / 1000) * 255, h, s: s / 10};
                result.brightness = result.color.b;
            } else if (dp === common.TuyaDataPoints.silvercrestSetEffect) {
                result.effect = {
                    effect: utils.getKeyStringByValue(common.silvercrestEffects, value.substring(0, 2), ''),
                    speed: (parseInt(value.substring(2, 4)) / 64) * 100,
                    colors: [],
                };

                const colorsString = value.substring(4);
                // Colors are 6 characters.
                const n = Math.floor(colorsString.length / 6);

                // The incoming message can contain anywhere between 0 to 6 colors.
                // In the following loop we're extracting every color the led
                // string gives us.
                for (let i = 0; i < n; ++i) {
                    const part = colorsString.substring(i * 6, (i + 1) * 6);
                    const r = part[0]+part[1]; const g = part[2]+part[3]; const b = part[4]+part[5];
                    result.effect.colors.push({
                        r: parseInt(r, 16),
                        g: parseInt(g, 16),
                        b: parseInt(b, 16),
                    });
                }
            }

            return result;
        },
    },
    heiman_ir_remote: {
        cluster: 'heimanSpecificInfraRedRemote',
        type: ['commandStudyKeyRsp', 'commandCreateIdRsp', 'commandGetIdAndKeyCodeListRsp'],
        convert: (model, msg, publish, options, meta) => {
            switch (msg.type) {
            case 'commandStudyKeyRsp':
                return {
                    action: 'learn',
                    action_result: msg.data.result === 1 ? 'success' : 'error',
                    action_key_code: msg.data.keyCode,
                    action_id: msg.data.result === 1 ? msg.data.id : undefined,
                };
            case 'commandCreateIdRsp':
                return {
                    action: 'create',
                    action_result: msg.data.id === 0xFF ? 'error' : 'success',
                    action_model_type: msg.data.modelType,
                    action_id: msg.data.id !== 0xFF ? msg.data.id : undefined,
                };
            case 'commandGetIdAndKeyCodeListRsp': {
                // See cluster.js with data format description
                if (msg.data.packetNumber === 1) {
                    // start to collect and merge list
                    // so, we use store instance for temp storage during merging
                    globalStore.putValue(msg.endpoint, 'db', []);
                }
                const buffer = msg.data.learnedDevicesList;
                for (let i = 0; i < msg.data.packetLength;) {
                    const modelDescription = {
                        id: buffer[i],
                        model_type: buffer[i + 1],
                        key_codes: [],
                    };
                    const numberOfKeys = buffer[i + 2];
                    for (let j = i + 3; j < i + 3 + numberOfKeys; j++) {
                        modelDescription.key_codes.push(buffer[j]);
                    }
                    i = i + 3 + numberOfKeys;
                    globalStore.getValue(msg.endpoint, 'db').push(modelDescription);
                }
                if (msg.data.packetNumber === msg.data.packetsTotal) {
                    // last packet, all data collected, can publish
                    const result = {
                        'devices': globalStore.getValue(msg.endpoint, 'db'),
                    };
                    globalStore.clearValue(msg.endpoint, 'db');
                    return result;
                }
                break;
            }
            }
        },
    },
    meazon_meter: {
        cluster: 'seMetering',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            // typo on property name to stick with zcl definition
            if (msg.data.hasOwnProperty('inletTempreature')) {
                result.inlet_temperature = precisionRound(msg.data['inletTempreature'], 2);
                result.inletTemperature = result.inlet_temperature; // deprecated
            }

            if (msg.data.hasOwnProperty('status')) {
                result.status = precisionRound(msg.data['status'], 2);
            }

            if (msg.data.hasOwnProperty('8192')) {
                result.line_frequency = precisionRound((parseFloat(msg.data['8192'])) / 100.0, 2);
                result.linefrequency = result.line_frequency; // deprecated
            }

            if (msg.data.hasOwnProperty('8193')) {
                result.power = precisionRound(msg.data['8193'], 2);
            }

            if (msg.data.hasOwnProperty('8196')) {
                result.voltage = precisionRound(msg.data['8196'], 2);
            }

            if (msg.data.hasOwnProperty('8213')) {
                result.voltage = precisionRound(msg.data['8213'], 2);
            }

            if (msg.data.hasOwnProperty('8199')) {
                result.current = precisionRound(msg.data['8199'], 2);
            }

            if (msg.data.hasOwnProperty('8216')) {
                result.current = precisionRound(msg.data['8216'], 2);
            }

            if (msg.data.hasOwnProperty('8202')) {
                result.reactive_power = precisionRound(msg.data['8202'], 2);
                result.reactivepower = result.reactive_power; // deprecated
            }

            if (msg.data.hasOwnProperty('12288')) {
                result.energy_consumed = precisionRound(msg.data['12288'], 2);
                result.energyconsumed = result.energy_consumed; // deprecated
            }

            if (msg.data.hasOwnProperty('12291')) {
                result.energy_produced = precisionRound(msg.data['12291'], 2);
                result.energyproduced = result.energy_produced; // deprecated
            }

            if (msg.data.hasOwnProperty('12294')) {
                result.reactive_summation = precisionRound(msg.data['12294'], 2);
                result.reactivesummation = result.reactive_summation; // deprecated
            }

            if (msg.data.hasOwnProperty('16408')) {
                result.measure_serial = precisionRound(msg.data['16408'], 2);
                result.measureserial = result.measure_serial; // deprecated
            }

            return result;
        },
    },
    sinope_TH1300ZB_specific: {
        cluster: 'manuSpecificSinope',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const lookup = {0: 'off', 1: 'on'};
            const result = {};
            if (msg.data.hasOwnProperty('GFCiStatus')) {
                result.gfci_status = lookup[msg.data['GFCiStatus']];
            }
            if (msg.data.hasOwnProperty('floorLimitStatus')) {
                result.floor_limit_status = lookup[msg.data['floorLimitStatus']];
            }
            return result;
        },
    },
    danfoss_thermostat: {
        cluster: 'hvacThermostat',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            // Danfoss sends pi_heating_demand as raw %
            if (typeof msg.data['pIHeatingDemand'] == 'number') {
                result[postfixWithEndpointName('pi_heating_demand', msg, model)] =
                    precisionRound(msg.data['pIHeatingDemand'], 0);
            }
            if (typeof msg.data[0x4000] == 'number') {
                result[postfixWithEndpointName('window_open_internal', msg, model)] = (msg.data[0x4000]);
            }
            if (typeof msg.data[0x4003] == 'number') {
                result[postfixWithEndpointName('window_open_external', msg, model)] = (msg.data[0x4003] == 0x01);
            }
            if (typeof msg.data[0x4010] == 'number') {
                result[postfixWithEndpointName('day_of_week', msg, model)] = msg.data[0x4010];
            }
            if (typeof msg.data[0x4011] == 'number') {
                result[postfixWithEndpointName('trigger_time', msg, model)] = msg.data[0x4011];
            }
            if (typeof msg.data[0x4012] == 'number') {
                result[postfixWithEndpointName('mounted_mode', msg, model)] = (msg.data[0x4012]==1);
            }
            if (typeof msg.data[0x4013] == 'number') {
                result[postfixWithEndpointName('mounted_mode_control', msg, model)] = (msg.data[0x4013]==0x00);
            }
            if (typeof msg.data[0x4014] == 'number') {
                result[postfixWithEndpointName('thermostat_orientation', msg, model)] = msg.data[0x4014];
            }
            if (typeof msg.data[0x4020] == 'number') {
                result[postfixWithEndpointName('algorithm_scale_factor', msg, model)] = msg.data[0x4020];
            }
            if (typeof msg.data[0x4030] == 'number') {
                result[postfixWithEndpointName('heat_available', msg, model)] = (msg.data[0x4030]==0x01);
            }
            if (typeof msg.data[0x4031] == 'number') {
                result[postfixWithEndpointName('heat_required', msg, model)] = (msg.data[0x4031]==0x01);
            }
            return result;
        },
    },
    orvibo_raw_1: {
        cluster: 23,
        type: 'raw',
        convert: (model, msg, publish, options, meta) => {
            // 25,0,8,3,0,0 - click btn 1
            // 25,0,8,3,0,2 - hold btn 1
            // 25,0,8,3,0,3 - release btn 1
            // 25,0,8,11,0,0 - click btn 2
            // 25,0,8,11,0,2 - hold btn 2
            // 25,0,8,11,0,3 - release btn 2
            // 25,0,8,7,0,0 - click btn 3
            // 25,0,8,7,0,2 - hold btn 3
            // 25,0,8,7,0,3 - release btn 3
            // 25,0,8,15,0,0 - click btn 4
            // 25,0,8,15,0,2 - hold btn 4
            // 25,0,8,15,0,3 - release btn 4
            // TODO: do not know how to get to use 5,6,7,8 buttons
            const buttonLookup = {
                3: 'button_1',
                11: 'button_2',
                7: 'button_3',
                15: 'button_4',
            };

            const actionLookup = {
                0: 'click',
                2: 'hold',
                3: 'release',
            };
            const button = buttonLookup[msg.data[3]];
            const action = actionLookup[msg.data[5]];
            if (button) {
                return {action: `${button}_${action}`};
            }
        },
    },
    orvibo_raw_2: {
        cluster: 23,
        type: 'raw',
        convert: (model, msg, publish, options, meta) => {
            const buttonLookup = {
                1: 'button_1',
                2: 'button_2',
                3: 'button_3',
                4: 'button_4',
                5: 'button_5',
                6: 'button_6',
                7: 'button_7',
            };

            const actionLookup = {
                0: 'click',
                2: 'hold',
                3: 'release',
            };
            const button = buttonLookup[msg.data[3]];
            const action = actionLookup[msg.data[5]];
            if (button) {
                return {action: `${button}_${action}`};
            }
        },
    },
    tint_scene: {
        cluster: 'genBasic',
        type: 'write',
        convert: (model, msg, publish, options, meta) => {
            const payload = {action: `scene_${msg.data['16389']}`};
            addActionGroup(payload, msg, model);
            return payload;
        },
    },
    ZNMS11LM_closuresDoorLock_report: {
        cluster: 'closuresDoorLock',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            const lockStatusLookup = {
                1: 'finger_not_match',
                2: 'password_not_match',
                3: 'reverse_lock', // disable open from outside
                4: 'reverse_lock_cancel', // enable open from outside
                5: 'locked',
                6: 'lock_opened',
                7: 'finger_add',
                8: 'finger_delete',
                9: 'password_add',
                10: 'password_delete',
                11: 'lock_opened_inside', // Open form inside reverse lock enbable
                12: 'lock_opened_outside', // Open form outside reverse lock disable
                13: 'ring_bell',
                14: 'change_language_to',
                15: 'finger_open',
                16: 'password_open',
                17: 'door_closed',
            };
            if (msg.data['65296']) { // finger/password success
                const data = msg.data['65296'].toString(16);
                const command = data.substr(0, 1); // 1 finger open, 2 password open
                const userId = data.substr(5, 2);
                const userType = data.substr(1, 1); // 1 admin, 2 user
                result.data = data;
                result.action = (lockStatusLookup[14+parseInt(command, 16)] +
                    (userType === '1' ? '_admin' : '_user') + '_id' + parseInt(userId, 16).toString());
                result.action_user = parseInt(userId, 16);
            } else if (msg.data['65297']) { // finger, password failed or bell
                const data = msg.data['65297'].toString(16);
                const times = data.substr(0, 1);
                const type = data.substr(5, 2); // 00 bell, 02 password, 40 error finger
                result.data = data;
                if (type === '40') {
                    result.action_action = lockStatusLookup[1];
                    result.action_repeat = parseInt(times, 16);
                } else if (type === '02') {
                    result.action = lockStatusLookup[2];
                    result.action_repeat = parseInt(times, 16);
                } else if (type === '00') {
                    result.action = lockStatusLookup[13];
                }
            } else if (msg.data['65281'] && msg.data['65281']['1']) { // user added/delete
                const data = msg.data['65281']['1'].toString(16);
                const command = data.substr(0, 1); // 1 add, 2 delete
                const userId = data.substr(5, 2);
                result.data = data;
                result.action = lockStatusLookup[6+parseInt(command, 16)];
                result.action_user = parseInt(userId, 16);
            }

            if (isLegacyEnabled(options)) {
                result.repeat = result.action_repeat;
                result.user = result.action_user;
            } else {
                delete result.data;
            }

            return result;
        },
    },
    ZNMS12LM_ZNMS13LM_closuresDoorLock_report: {
        cluster: 'closuresDoorLock',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            const lockStatusLookup = {
                1: 'finger_not_match',
                2: 'password_not_match',
                3: 'reverse_lock', // disable open from outside
                4: 'reverse_lock_cancel', // enable open from outside
                5: 'locked',
                6: 'lock_opened',
                7: 'finger_add',
                8: 'finger_delete',
                9: 'password_add',
                10: 'password_delete',
                11: 'lock_opened_inside', // Open form inside reverse lock enbable
                12: 'lock_opened_outside', // Open form outside reverse lock disable
                13: 'ring_bell',
                14: 'change_language_to',
                15: 'finger_open',
                16: 'password_open',
                17: 'door_closed',
            };

            if (msg.data['65526']) { // lock final status
                // Convert data back to hex to decode
                const data = Buffer.from(msg.data['65526'], 'ascii').toString('hex');
                const command = data.substr(6, 4);
                if (
                    command === '0301' || // ZNMS12LM
                        command === '0341' // ZNMS13LM
                ) {
                    result.action = lockStatusLookup[4];
                    result.state = 'UNLOCK';
                    result.reverse = 'UNLOCK';
                } else if (
                    command === '0311' || // ZNMS12LM
                        command === '0351' // ZNMS13LM
                ) {
                    result.action = lockStatusLookup[4];
                    result.state = 'LOCK';
                    result.reverse = 'UNLOCK';
                } else if (
                    command === '0205' || // ZNMS12LM
                        command === '0245' // ZNMS13LM
                ) {
                    result.action = lockStatusLookup[3];
                    result.state = 'UNLOCK';
                    result.reverse = 'LOCK';
                } else if (
                    command === '0215' || // ZNMS12LM
                        command === '0255' || // ZNMS13LM
                        command === '1355' // ZNMS13LM
                ) {
                    result.action = lockStatusLookup[3];
                    result.state = 'LOCK';
                    result.reverse = 'LOCK';
                } else if (
                    command === '0111' || // ZNMS12LM
                        command === '1351' || // ZNMS13LM locked from inside
                        command === '1451' // ZNMS13LM locked from outside
                ) {
                    result.action = lockStatusLookup[5];
                    result.state = 'LOCK';
                    result.reverse = 'UNLOCK';
                } else if (
                    command === '0b00' || // ZNMS12LM
                        command === '0640' || // ZNMS13LM
                        command === '0600' // ZNMS13LM

                ) {
                    result.action = lockStatusLookup[12];
                    result.state = 'UNLOCK';
                    result.reverse = 'UNLOCK';
                } else if (
                    command === '0c00' || // ZNMS12LM
                        command === '2300' || // ZNMS13LM
                        command === '0540' || // ZNMS13LM
                        command === '0440' // ZNMS13LM
                ) {
                    result.action = lockStatusLookup[11];
                    result.state = 'UNLOCK';
                    result.reverse = 'UNLOCK';
                } else if (
                    command === '2400' || // ZNMS13LM door closed from insed
                        command === '2401' // ZNMS13LM door closed from outside
                ) {
                    result.action = lockStatusLookup[17];
                    result.state = 'UNLOCK';
                    result.reverse = 'UNLOCK';
                }
            } else if (msg.data['65296']) { // finger/password success
                const data = Buffer.from(msg.data['65296'], 'ascii').toString('hex');
                const command = data.substr(6, 2); // 1 finger open, 2 password open
                const userId = data.substr(12, 2);
                const userType = data.substr(8, 1); // 1 admin, 2 user
                result.action = (lockStatusLookup[14+parseInt(command, 16)] +
                    (userType === '1' ? '_admin' : '_user') + '_id' + parseInt(userId, 16).toString());
                result.action_user = parseInt(userId, 16);
            } else if (msg.data['65297']) { // finger, password failed or bell
                const data = Buffer.from(msg.data['65297'], 'ascii').toString('hex');
                const times = data.substr(6, 2);
                const type = data.substr(12, 2); // 00 bell, 02 password, 40 error finger
                if (type === '40') {
                    result.action = lockStatusLookup[1];
                    result.action_repeat = parseInt(times, 16);
                } else if (type === '00') {
                    result.action = lockStatusLookup[13];
                    result.action_repeat = null;
                } else if (type === '02') {
                    result.action = lockStatusLookup[2];
                    result.action_repeat = parseInt(times, 16);
                }
            } else if (msg.data['65281']) { // password added/delete
                const data = Buffer.from(msg.data['65281'], 'ascii').toString('hex');
                const command = data.substr(18, 2); // 1 add, 2 delete
                const userId = data.substr(12, 2);
                result.action = lockStatusLookup[6+parseInt(command, 16)];
                result.action_user = parseInt(userId, 16);
            } else if (msg.data['65522']) { // set languge
                const data = Buffer.from(msg.data['65522'], 'ascii').toString('hex');
                const langId = data.substr(6, 2); // 1 chinese, 2: english
                result.action = (lockStatusLookup[14])+ (langId==='2'?'_english':'_chinese');
            }

            if (isLegacyEnabled(options)) {
                result.repeat = result.action_repeat;
                result.user = result.action_user;
            }

            return result;
        },
    },
    moes_thermostat: {
        cluster: 'manuSpecificTuya',
        type: ['commandGetData', 'commandSetDataResponse'],
        convert: moesThermostat,
    },
    saswell_thermostat: {
        cluster: 'manuSpecificTuya',
        type: ['commandGetData', 'commandSetDataResponse'],
        convert: saswellThermostat,
    },
    etop_thermostat: {
        cluster: 'manuSpecificTuya',
        type: ['commandGetData', 'commandSetDataResponse'],
        convert: eTopThermostat,
    },
    tuya_thermostat: {
        cluster: 'manuSpecificTuya',
        type: ['commandGetData', 'commandSetDataResponse'],
        convert: tuyaThermostat,
    },
    tuya_dimmer: {
        cluster: 'manuSpecificTuya',
        type: ['commandGetData', 'commandSetDataResponse'],
        convert: (model, msg, publish, options, meta) => {
            const value = tuyaGetDataValue(msg.data.datatype, msg.data.data);
            if (msg.data.dp === common.TuyaDataPoints.state) {
                return {state: value ? 'ON': 'OFF'};
            } else { // TODO: Unknown dp, assumed value type
                const normalised = (value - 10) / (1000 - 10);
                return {brightness: Math.round(normalised * 254), level: value};
            }
        },
    },
    tuya_data_point_dump: {
        cluster: 'manuSpecificTuya',
        type: ['commandGetData', 'commandSetDataResponse'],
        convert: (model, msg, publis, options, meta) => {
            // Don't use in production!
            // Used in: https://www.zigbee2mqtt.io/how_tos/how_to_support_new_tuya_devices.html
            const getHex = (value) => {
                let hex = value.toString(16);
                if (hex.length < 2) {
                    hex = '0' + hex;
                }
                return hex;
            };
            let dataStr =
                Date.now().toString() + ' ' +
                meta.device.ieeeAddr + ' ' +
                getHex(msg.data.status) + ' ' +
                getHex(msg.data.transid) + ' ' +
                getHex(msg.data.dp) + ' ' +
                getHex(msg.data.datatype) + ' ' +
                getHex(msg.data.fn);

            msg.data.data.forEach((elem) => {
                dataStr += ' ' + getHex(elem);
            });
            dataStr += '\n';
            const fs = require('fs');
            fs.appendFile('data/tuya.dump.txt', dataStr, (err) => {
                if (err) throw err;
            });
        },
    },
    restorable_brightness: {
        cluster: 'genLevelCtrl',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.hasOwnProperty('currentLevel')) {
                // Ignore brightness = 0, which only happens when state is OFF
                if (Number(msg.data['currentLevel']) > 0) {
                    return {brightness: msg.data['currentLevel']};
                }
                return {};
            }
        },
    },
    blitzwolf_occupancy_with_timeout: {
        cluster: 'manuSpecificTuya',
        type: 'commandGetData',
        convert: (model, msg, publish, options, meta) => {
            msg.data.occupancy = msg.data.dp === common.TuyaDataPoints.occupancy ? 1 : 0;
            return converters.occupancy_with_timeout.convert(model, msg, publish, options, meta);
        },
    },
    E1524_E1810_toggle: {
        cluster: 'genOnOff',
        type: 'commandToggle',
        convert: (model, msg, publish, options, meta) => {
            return {action: postfixWithEndpointName('toggle', msg, model)};
        },
    },
    E1524_E1810_arrow_click: {
        cluster: 'genScenes',
        type: 'commandTradfriArrowSingle',
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.value === 2) {
                // This is send on toggle hold, ignore it as a toggle_hold is already handled above.
                return;
            }

            const direction = msg.data.value === 257 ? 'left' : 'right';
            return {action: `arrow_${direction}_click`};
        },
    },
    E1524_E1810_arrow_hold: {
        cluster: 'genScenes',
        type: 'commandTradfriArrowHold',
        convert: (model, msg, publish, options, meta) => {
            const direction = msg.data.value === 3329 ? 'left' : 'right';
            globalStore.putValue(msg.endpoint, 'direction', direction);
            return {action: `arrow_${direction}_hold`};
        },
    },
    E1524_E1810_arrow_release: {
        cluster: 'genScenes',
        type: 'commandTradfriArrowRelease',
        convert: (model, msg, publish, options, meta) => {
            const direction = globalStore.getValue(msg.endpoint, 'direction');
            if (direction) {
                globalStore.clearValue(msg.endpoint, 'direction');
                const duration = msg.data.value / 1000;
                const result = {action: `arrow_${direction}_release`, duration, action_duration: duration};
                if (!isLegacyEnabled(options)) delete result.duration;
                return result;
            }
        },
    },
    E1524_E1810_levelctrl: {
        cluster: 'genLevelCtrl',
        type: [
            'commandStepWithOnOff', 'commandStep', 'commandMoveWithOnOff', 'commandStopWithOnOff', 'commandMove', 'commandStop',
            'commandMoveToLevelWithOnOff',
        ],
        convert: (model, msg, publish, options, meta) => {
            const lookup = {
                commandStepWithOnOff: 'brightness_up_click',
                commandStep: 'brightness_down_click',
                commandMoveWithOnOff: 'brightness_up_hold',
                commandStopWithOnOff: 'brightness_up_release',
                commandMove: 'brightness_down_hold',
                commandStop: 'brightness_down_release',
                commandMoveToLevelWithOnOff: 'toggle_hold',
            };
            return {action: lookup[msg.type]};
        },
    },
    ewelink_action: {
        cluster: 'genOnOff',
        type: ['commandOn', 'commandOff', 'commandToggle'],
        convert: (model, msg, publish, options, meta) => {
            const lookup = {'commandToggle': 'single', 'commandOn': 'double', 'commandOff': 'long'};
            return {action: lookup[msg.type]};
        },
    },
    diyruz_contact: {
        cluster: 'genOnOff',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            return {contact: msg.data['onOff'] !== 0};
        },
    },
    diyruz_rspm: {
        cluster: 'genOnOff',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const power = precisionRound(msg.data['41364'], 2);
            return {
                state: msg.data['onOff'] === 1 ? 'ON' : 'OFF',
                cpu_temperature: precisionRound(msg.data['41361'], 2),
                power: power,
                current: precisionRound(power/230, 2),
                action: msg.data['41367'] === 1 ? 'hold' : 'release',
            };
        },
    },
    K4003C_binary_input: {
        cluster: 'genBinaryInput',
        type: 'attributeReport',
        convert: (model, msg, publish, options, meta) => {
            return {action: msg.data.presentValue === 1 ? 'off' : 'on'};
        },
    },
    greenpower_on_off_switch: {
        cluster: 'greenPower',
        type: ['commandNotification', 'commandCommisioningNotification'],
        convert: (model, msg, publish, options, meta) => {
            const commandID = msg.data.commandID;
            if (hasAlreadyProcessedMessage(msg, msg.data.frameCounter, `${msg.device.ieeeAddr}_${commandID}`)) return;
            if (commandID === 224) return; // Skip commisioning command.
            const lookup = {
                0x00: 'identify',
                0x10: 'recall_scene_0',
                0x11: 'recall_scene_1',
                0x12: 'recall_scene_2',
                0x13: 'recall_scene_3',
                0x14: 'recall_scene_4',
                0x15: 'recall_scene_5',
                0x16: 'recall_scene_6',
                0x17: 'recall_scene_7',
                0x18: 'store_scene_0',
                0x19: 'store_scene_1',
                0x1A: 'store_scene_2',
                0x1B: 'store_scene_3',
                0x1C: 'store_scene_4',
                0x1D: 'store_scene_5',
                0x1E: 'store_scene_6',
                0x1F: 'store_scene_7',
                0x20: 'off',
                0x21: 'on',
                0x22: 'toggle',
                0x23: 'release',
                0x60: 'press_1_of_1',
                0x61: 'release_1_of_1',
                0x62: 'press_1_of_2',
                0x63: 'release_1_of_2',
                0x64: 'press_2_of_2',
                0x65: 'release_2_of_2',
                0x66: 'short_press_1_of_1',
                0x67: 'short_press_1_of_2',
                0x68: 'short_press_2_of_1',
            };

            return {action: lookup[commandID] || commandID.toString()};
        },
    },
    greenpower_7: {
        cluster: 'greenPower',
        type: ['commandNotification', 'commandCommisioningNotification'],
        convert: (model, msg, publish, options, meta) => {
            const commandID = msg.data.commandID;
            if (hasAlreadyProcessedMessage(msg, msg.data.frameCounter, `${msg.device.ieeeAddr}_${commandID}`)) return;
            if (commandID === 224) return; // Skip commisioning command.
            let postfix = '';

            if (msg.data.commandFrame && msg.data.commandFrame.raw) {
                postfix = `_${[...msg.data.commandFrame.raw].join('_')}`;
            }

            return {action: `${commandID.toString()}${postfix}`};
        },
    },
    lifecontrolVoc: {
        cluster: 'msTemperatureMeasurement',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const temperature = parseFloat(msg.data['measuredValue']) / 100.0;
            const humidity = parseFloat(msg.data['minMeasuredValue']) / 100.0;
            const eco2 = parseFloat(msg.data['maxMeasuredValue']);
            const voc = parseFloat(msg.data['tolerance']);
            return {
                temperature: calibrateAndPrecisionRoundOptions(temperature, options, 'temperature'),
                humidity: calibrateAndPrecisionRoundOptions(humidity, options, 'humidity'),
                eco2, voc,
            };
        },
    },
    _8840100H_water_leak_alarm: {
        cluster: 'haApplianceEventsAlerts',
        type: 'commandAlertsNotification',
        convert: (model, msg, publish, options, meta) => {
            const alertStatus = msg.data.aalert;
            return {
                water_leak: (alertStatus & 1<<12) > 0,
            };
        },
    },
    E1E_G7F_action: {
        cluster: 64528,
        type: ['raw'],
        convert: (model, msg, publish, options, meta) => {
            // A list of commands the sixth digit in the raw data can map to
            const lookup = {
                1: 'on',
                2: 'up',
                // Two outputs for long press. The eighth digit outputs 1 for initial press then 2 for each
                // LED blink (approx 1 second, repeating until release)
                3: 'down', // Same as above
                4: 'off',
                5: 'on_double',
                6: 'on_long',
                7: 'off_double',
                8: 'off_long',
            };

            if (msg.data[7] === 2) { // If the 8th digit is 2 (implying long press)
                // Append '_long' to the end of the action so the user knows it was a long press.
                // This only applies to the up and down action
                return {action: `${lookup[msg.data[5]]}_long`};
            } else {
                return {action: lookup[msg.data[5]]}; // Just output the data from the above lookup list
            }
        },
    },
    diyruz_freepad_clicks: {
        cluster: 'genMultistateInput',
        type: ['readResponse', 'attributeReport'],
        convert: (model, msg, publish, options, meta) => {
            const button = getKey(model.endpoint(msg.device), msg.endpoint.ID);
            const lookup = {0: 'hold', 1: 'single', 2: 'double', 3: 'triple', 4: 'quadruple', 255: 'release'};
            const clicks = msg.data['presentValue'];
            const action = lookup[clicks] ? lookup[clicks] : `many_${clicks}`;
            return {action: `${button}_${action}`};
        },
    },
    ZG2819S_command_on: {
        cluster: 'genOnOff',
        type: 'commandOn',
        convert: (model, msg, publish, options, meta) => {
            // The device sends this command for all four group IDs.
            // Only forward for the first group.
            if (msg.groupID !== 46337) return null;
            return {action: postfixWithEndpointName('on', msg, model)};
        },
    },
    ZG2819S_command_off: {
        cluster: 'genOnOff',
        type: 'commandOff',
        convert: (model, msg, publish, options, meta) => {
            // The device sends this command for all four group IDs.
            // Only forward for the first group.
            if (msg.groupID !== 46337) return null;
            return {action: postfixWithEndpointName('off', msg, model)};
        },
    },
    kmpcil_res005_occupancy: {
        cluster: 'genBinaryInput',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            return {occupancy: (msg.data['presentValue']===1)};
        },
    },
    kmpcil_res005_on_off: {
        cluster: 'genBinaryOutput',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            return {state: (msg.data['presentValue']==0) ? 'OFF' : 'ON'};
        },
    },
    _3310_humidity: {
        cluster: 'manuSpecificCentraliteHumidity',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const humidity = parseFloat(msg.data['measuredValue']) / 100.0;
            return {humidity: calibrateAndPrecisionRoundOptions(humidity, options, 'humidity')};
        },
    },
    tuya_switch_1: {
        cluster: 'manuSpecificTuya',
        type: 'raw',
        convert: (model, msg, publish, options, meta) => {
            const key = msg.data[5];
            const val = msg.data[9];
            const lookup = {1: 'state_l1', 2: 'state_l2', 3: 'state_l3', 4: 'state_l4'};
            return {[lookup[key]]: (val) ? 'ON': 'OFF'};
        },
    },
    tuya_switch_2: {
        cluster: 'manuSpecificTuya',
        type: ['commandSetDataResponse', 'commandGetData'],
        convert: (model, msg, publish, options, meta) => {
            const multiEndpoint = model.meta && model.meta.multiEndpoint;
            const dp = msg.data.dp;
            const value = tuyaGetDataValue(msg.data.datatype, msg.data.data);
            const state = value ? 'ON' : 'OFF';
            if (multiEndpoint) {
                const lookup = {1: 'l1', 2: 'l2', 3: 'l3'};
                const endpoint = lookup[dp];
                if (endpoint in model.endpoint(msg.device)) {
                    return {[`state_${endpoint}`]: state};
                }
            } else if (dp === common.TuyaDataPoints.state) {
                return {state: state};
            }
            return null;
        },
    },
    smartthings_acceleration: {
        cluster: 'manuSpecificSamsungAccelerometer',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            return {moving: msg.data['acceleration'] === 1 ? true : false};
        },
    },
    byun_smoke_false: {
        cluster: 'pHMeasurement',
        type: ['attributeReport'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.endpoint.ID == 1 && msg.data['measuredValue'] == 0) {
                return {smoke: false};
            }
        },
    },
    byun_smoke_true: {
        cluster: 'ssIasZone',
        type: ['commandStatusChangeNotification'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.endpoint.ID == 1 && msg.data['zonestatus'] == 33) {
                return {smoke: true};
            }
        },
    },
    hue_smart_button_event: {
        cluster: 'manuSpecificPhilips',
        type: 'commandHueNotification',
        convert: (model, msg, publish, options, meta) => {
            // Philips HUE Smart Button "ROM001": these events are always from "button 1"
            const lookup = {0: 'press', 1: 'hold', 2: 'release', 3: 'release'};
            return {action: lookup[msg.data['type']]};
        },
    },
    legrand_binary_input_moving: {
        cluster: 'genBinaryInput',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            return {action: msg.data.presentValue ? 'moving' : 'stopped'};
        },
    },
    legrand_scenes: {
        cluster: 'genScenes',
        type: 'commandRecall',
        convert: (model, msg, publish, options, meta) => {
            const lookup = {0xfff7: 'enter', 0xfff6: 'leave', 0xfff4: 'sleep', 0xfff5: 'wakeup'};
            return {action: lookup[msg.data.groupid] ? lookup[msg.data.groupid] : 'default'};
        },
    },
    legrand_master_switch_center: {
        cluster: 'manuSpecificLegrandDevices',
        type: 'raw',
        convert: (model, msg, publish, options, meta) => {
            if (msg.data && msg.data.length === 6 && msg.data[0] === 0x15 && msg.data[1] === 0x21 && msg.data[2] === 0x10 &&
                msg.data[3] === 0x00 && msg.data[4] === 0x03 && msg.data[5] === 0xff) {
                return {action: 'center'};
            }
        },
    },
    legrand_device_mode: {
        cluster: 'manuSpecificLegrandDevices',
        type: ['readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const payload = {};
            const option0 = msg.data['0'];
            // Beware that mode depends on device type
            // contactor
            if (option0 === 0x0003) payload.device_mode = 'switch';
            else if (option0 === 0x0004) payload.device_mode = 'auto';
            // dimmer
            else if (option0 === 0x0101) payload.device_mode = 'dimmer_on';
            else if (option0 === 0x0100) payload.device_mode = 'dimmer_off';
            // unknown case
            else {
                meta.logger.warn(`device_mode ${option0} not recognized, please fix me`);
                payload.device_mode = 'unknown';
            }
            return payload;
        },
    },
    legrand_power_alarm: {
        cluster: 'haElectricalMeasurement',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const payload = {};

            // 0xf000 = 61440
            // This attribute returns usually 2 when power is over the defined threshold.
            if (msg.data.hasOwnProperty('61440')) {
                payload.power_alarm_active_value = msg.data['61440'];
                payload.power_alarm_active = (payload.power_alarm_active_value > 0);
            }
            // 0xf001 = 61441
            if (msg.data.hasOwnProperty('61441')) {
                payload.power_alarm_enabled = msg.data['61441'];
            }
            // 0xf002 = 61442, wh = watt hour
            if (msg.data.hasOwnProperty('61442')) {
                payload.power_alarm_wh_threshold = msg.data['61442'];
            }
            return payload;
        },
    },
    xiaomi_power: {
        cluster: 'genAnalogInput',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            return {power: precisionRound(msg.data['presentValue'], 2)};
        },
    },
    xiaomi_switch_basic: {
        cluster: 'genBasic',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data['65281']) {
                const data = msg.data['65281'];
                const payload = {};

                if (data.hasOwnProperty('100')) {
                    payload.state = data['100'] === 1 ? 'ON' : 'OFF';
                }

                if (data.hasOwnProperty('152')) {
                    payload.power = precisionRound(data['152'], 2);
                }

                if (data.hasOwnProperty('149')) {
                    // Consumption is deprecated
                    payload.consumption = precisionRound(data['149'], 2);
                    payload.energy = precisionRound(data['149'], 2);
                }

                if (data.hasOwnProperty('3')) {
                    payload.temperature = calibrateAndPrecisionRoundOptions(data['3'], options, 'temperature');
                }

                if (data.hasOwnProperty('150')) {
                    payload.voltage = precisionRound(data['150'] * 0.1, 1);
                }

                return payload;
            }
        },
    },
    xiaomi_switch_opple_basic: {
        cluster: 'aqaraOpple',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const payload = {};
            if (msg.data.hasOwnProperty('247')) {
                const data = msg.data['247'];
                // Xiaomi struct parsing
                const length = data.length;
                // if (meta.logger) meta.logger.debug(`plug.mmeu01: Xiaomi struct: length ${length}`);
                for (let i=0; i < length; i++) {
                    const index = data[i];
                    let value = null;
                    // if (meta.logger) meta.logger.debug(`plug.mmeu01: pos=${i}, ind=${data[i]}, vtype=${data[i+1]}`);
                    switch (data[i+1]) {
                    case 16:
                        // 0x10 ZclBoolean
                        value = data.readUInt8(i+2);
                        i += 2;
                        break;
                    case 32:
                        // 0x20 Zcl8BitUint
                        value = data.readUInt8(i+2);
                        i += 2;
                        break;
                    case 33:
                        // 0x21 Zcl16BitUint
                        value = data.readUInt16LE(i+2);
                        i += 3;
                        break;
                    case 39:
                        // 0x27 Zcl64BitUint
                        i += 9;
                        break;
                    case 40:
                        // 0x28 Zcl8BitInt
                        value = data.readInt8(i+2);
                        i += 2;
                        break;
                    case 57:
                        // 0x39 ZclSingleFloat
                        value = data.readFloatLE(i+2);
                        i += 5;
                        break;
                    default:
                        if (meta.logger) meta.logger.debug(`plug.mmeu01: unknown vtype=${data[i+1]}, pos=${i+1}`);
                    }
                    if (index === 3) payload.temperature = calibrateAndPrecisionRoundOptions(value, options, 'temperature'); // 0x03
                    else if (index === 100) payload.state = value === 1 ? 'ON' : 'OFF'; // 0x64
                    else if (index === 149) payload.consumption = precisionRound(value, 2); // 0x95
                    else if (index === 150) payload.voltage = precisionRound(value * 0.1, 1); // 0x96
                    else if (index === 151) payload.current = precisionRound(value * 0.001, 4); // 0x97
                    else if (index === 152) payload.power = precisionRound(value, 2); // 0x98
                    else if (meta.logger) meta.logger.debug(`plug.mmeu01: unknown index ${index} with value ${value}`);
                }
            }
            if (msg.data.hasOwnProperty('513')) payload.power_outage_memory = msg.data['513'] === 1; // 0x0201
            if (msg.data.hasOwnProperty('514')) payload.auto_off = msg.data['514'] === 1; // 0x0202
            if (msg.data.hasOwnProperty('515')) payload.led_disabled_night = msg.data['515'] === 1; // 0x0203
            if (msg.data.hasOwnProperty('519')) payload.consumer_connected = msg.data['519'] === 1; // 0x0207
            if (msg.data.hasOwnProperty('523')) payload.consumer_overload = precisionRound(msg.data['523'], 2); // 0x020B
            return payload;
        },
    },
    xiaomi_battery: {
        cluster: 'genBasic',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            let voltage = null;
            if (msg.data['65281']) {
                voltage = msg.data['65281']['1'];
            } else if (msg.data['65282']) {
                voltage = msg.data['65282']['1'].elmVal;
            }

            if (voltage) {
                const payload = {
                    voltage: voltage, // @deprecated
                    // voltage: voltage / 1000.0,
                };

                if (model.meta && model.meta.battery && model.meta.battery.voltageToPercentage) {
                    if (model.meta.battery.voltageToPercentage === '3V_2100') {
                        payload.battery = toPercentage3V(payload.voltage);
                    } else if (model.meta.battery.voltageToPercentage === '4LR6AA1_5v') {
                        payload.battery = toPercentage(voltage, 3000, 4200);
                    }
                }

                return payload;
            }
        },
    },
    xiaomi_on_off_action: {
        cluster: 'genOnOff',
        type: ['attributeReport'],
        convert: (model, msg, publish, options, meta) => {
            if (['QBKG04LM', 'QBKG11LM', 'QBKG21LM', 'QBKG03LM', 'QBKG12LM', 'QBKG22LM'].includes(model.model) && msg.data['61440']) {
                return;
            }

            if (['QBKG21LM', 'QBKG04LM'].includes(model.model) && msg.endpoint.ID !== 4) return;

            let mapping = null;
            if (['QBKG03LM', 'QBKG12LM', 'QBKG22LM'].includes(model.model)) mapping = {4: 'left', 5: 'right', 6: 'both'};
            if (['WXKG02LM', 'WXKG07LM'].includes(model.model)) mapping = {1: 'left', 2: 'right', 3: 'both'};

            // Maybe other QKBG also support release/hold? Confirmed that release/hold doesn't work on WXKG02LM
            const actionLookup = !isLegacyEnabled(options) && ['QBKG03LM', 'QBKG22LM'].includes(model.model) ?
                {0: 'hold', 1: 'release'} : {0: 'single', 1: 'single'};

            // Dont' use postfixWithEndpointName here, endpoints don't match
            if (mapping) {
                if (mapping[msg.endpoint.ID]) {
                    const button = mapping[msg.endpoint.ID];
                    return {action: `${actionLookup[msg.data['onOff']]}_${button}`};
                }
            } else {
                return {action: actionLookup[msg.data['onOff']]};
            }
        },
    },
    xiaomi_multistate_action: {
        cluster: 'genMultistateInput',
        type: ['attributeReport'],
        convert: (model, msg, publish, options, meta) => {
            if (hasAlreadyProcessedMessage(msg)) return;
            let actionLookup = {0: 'hold', 1: 'single', 2: 'double', 3: 'triple', 255: 'release'};
            if (model.model === 'WXKG12LM') {
                actionLookup = {...actionLookup, 16: 'hold', 17: 'release', 18: 'shake'};
            }

            let buttonLookup = null;
            if (['WXKG02LM', 'WXKG07LM'].includes(model.model)) buttonLookup = {1: 'left', 2: 'right', 3: 'both'};
            if (['QBKG12LM', 'QBKG24LM'].includes(model.model)) buttonLookup = {5: 'left', 6: 'right', 7: 'both'};
            if (['QBKG25LM'].includes(model.model)) buttonLookup = {41: 'left', 42: 'center', 43: 'right'};

            const action = actionLookup[msg.data['presentValue']];
            if (buttonLookup) {
                const button = buttonLookup[msg.endpoint.ID];
                if (button) {
                    return {action: `${action}_${button}`};
                }
            } else {
                return {action};
            }
        },
    },
    RTCGQ11LM_interval: {
        cluster: 'genBasic',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data['65281']) {
                // DEPRECATED: only return lux here (change illuminance_lux -> illuminance)
                const illuminance = msg.data['65281']['11'];
                return {
                    illuminance: calibrateAndPrecisionRoundOptions(illuminance, options, 'illuminance'),
                    illuminance_lux: calibrateAndPrecisionRoundOptions(illuminance, options, 'illuminance_lux'),
                };
            }
        },
    },
    RTCGQ11LM_illuminance: {
        cluster: 'msIlluminanceMeasurement',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            // also trigger movement, because there is no illuminance without movement
            // https://github.com/Koenkk/zigbee-herdsman-converters/issues/1925
            msg.data.occupancy = 1;
            const payload = converters.occupancy_with_timeout.convert(model, msg, publish, options, meta);
            // DEPRECATED: only return lux here (change illuminance_lux -> illuminance)
            const illuminance = msg.data['measuredValue'];
            payload.illuminance = calibrateAndPrecisionRoundOptions(illuminance, options, 'illuminance');
            payload.illuminance_lux = calibrateAndPrecisionRoundOptions(illuminance, options, 'illuminance_lux');
            return payload;
        },
    },
    xiaomi_WXKG01LM_action: {
        cluster: 'genOnOff',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (hasAlreadyProcessedMessage(msg)) return;
            const deviceID = msg.device.ieeeAddr;
            const state = msg.data['onOff'];
            if (!store[deviceID]) store[deviceID] = {};

            // 0 = click down, 1 = click up, else = multiple clicks
            if (state === 0) {
                store[deviceID].timer = setTimeout(() => {
                    publish({action: 'hold'});
                    store[deviceID].timer = null;
                    store[deviceID].hold = Date.now();
                    store[deviceID].hold_timer = setTimeout(() => {
                        store[deviceID].hold = false;
                    }, options.hold_timeout_expire || 4000);
                    // After 4000 milliseconds of not reciving release we assume it will not happen.
                }, options.hold_timeout || 1000); // After 1000 milliseconds of not releasing we assume hold.
            } else if (state === 1) {
                if (store[deviceID].hold) {
                    const duration = Date.now() - store[deviceID].hold;
                    publish({action: 'release', duration: duration});
                    store[deviceID].hold = false;
                }

                if (store[deviceID].timer) {
                    clearTimeout(store[deviceID].timer);
                    store[deviceID].timer = null;
                    publish({action: 'single'});
                }
            } else {
                const clicks = msg.data['32768'];
                const actionLookup = {1: 'single', 2: 'double', 3: 'triple', 4: 'quadruple'};
                const payload = actionLookup[clicks] ? actionLookup[clicks] : 'many';
                publish({action: payload});
            }
        },
    },
    xiaomi_contact: {
        cluster: 'genOnOff',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            return {contact: msg.data['onOff'] === 0};
        },
    },
    xiaomi_contact_interval: {
        cluster: 'genBasic',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.hasOwnProperty('65281') && msg.data['65281'].hasOwnProperty('100')) {
                return {contact: msg.data['65281']['100'] === 0};
            }
        },
    },
    WSDCGQ11LM_pressure: {
        cluster: 'msPressureMeasurement',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const pressure = msg.data.hasOwnProperty('16') ? parseFloat(msg.data['16']) / 10 : parseFloat(msg.data['measuredValue']);
            return {pressure: calibrateAndPrecisionRoundOptions(pressure, options, 'pressure')};
        },
    },
    W2_module_carbon_monoxide: {
        cluster: 'ssIasZone',
        type: 'commandStatusChangeNotification',
        convert: (model, msg, publish, options, meta) => {
            const zoneStatus = msg.data.zonestatus;
            return {
                carbon_monoxide: (zoneStatus & 1<<8) > 8,
            };
        },
    },
    WSDCGQ01LM_WSDCGQ11LM_interval: {
        cluster: 'genBasic',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data['65281']) {
                const result = {};
                const temperature = parseFloat(msg.data['65281']['100']) / 100.0;
                const humidity = parseFloat(msg.data['65281']['101']) / 100.0;

                // https://github.com/Koenkk/zigbee2mqtt/issues/798
                // Sometimes the sensor publishes non-realistic vales, as the sensor only works from
                // -20 till +60, don't produce messages beyond these values.
                if (temperature > -25 && temperature < 65) {
                    result.temperature = calibrateAndPrecisionRoundOptions(temperature, options, 'temperature');
                }

                // in the 0 - 100 range, don't produce messages beyond these values.
                if (humidity >= 0 && humidity <= 100) {
                    result.humidity = calibrateAndPrecisionRoundOptions(humidity, options, 'humidity');
                }

                // Check if contains pressure (WSDCGQ11LM only)
                if (msg.data['65281'].hasOwnProperty('102')) {
                    const pressure = parseFloat(msg.data['65281']['102']) / 100.0;
                    result.pressure = calibrateAndPrecisionRoundOptions(pressure, options, 'pressure');
                }

                return result;
            }
        },
    },
    xiaomi_temperature: {
        cluster: 'msTemperatureMeasurement',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const temperature = parseFloat(msg.data['measuredValue']) / 100.0;

            // https://github.com/Koenkk/zigbee2mqtt/issues/798
            // Sometimes the sensor publishes non-realistic vales, as the sensor only works from
            // -20 till +60, don't produce messages beyond these values.
            if (temperature > -25 && temperature < 65) {
                return {temperature: calibrateAndPrecisionRoundOptions(temperature, options, 'temperature')};
            }
        },
    },
    xiaomi_WXKG11LM_action: {
        cluster: 'genOnOff',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            let clicks;
            if (msg.data.onOff) {
                clicks = 1;
            } else if (msg.data['32768']) {
                clicks = msg.data['32768'];
            }

            const actionLookup = {1: 'single', 2: 'double', 3: 'triple', 4: 'quadruple'};
            if (actionLookup[clicks]) {
                return {action: actionLookup[clicks]};
            }
        },
    },
    command_status_change_notification_action: {
        cluster: 'ssIasZone',
        type: 'commandStatusChangeNotification',
        convert: (model, msg, publish, options, meta) => {
            const lookup = {0: 'off', 1: 'single', 2: 'double', 3: 'hold'};
            return {action: lookup[msg.data.zonestatus]};
        },
    },
    ptvo_multistate_action: {
        cluster: 'genMultistateInput',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const actionLookup = {0: 'release', 1: 'single', 2: 'double', 3: 'tripple', 4: 'hold'};
            const value = msg.data['presentValue'];
            const action = actionLookup[value];
            return {action: postfixWithEndpointName(action, msg, model)};
        },
    },
    terncy_raw: {
        cluster: 'manuSpecificClusterAduroSmart',
        type: 'raw',
        convert: (model, msg, publish, options, meta) => {
            // 13,40,18,104, 0,8,1 - single
            // 13,40,18,22,  0,17,1
            // 13,40,18,32,  0,18,1
            // 13,40,18,6,   0,16,1
            // 13,40,18,111, 0,4,2 - double
            // 13,40,18,58,  0,7,2
            // 13,40,18,6,   0,2,3 - triple
            // motion messages:
            // 13,40,18,105, 4,167,0,7 - motion on right side
            // 13,40,18,96,  4,27,0,5
            // 13,40,18,101, 4,27,0,7
            // 13,40,18,125, 4,28,0,5
            // 13,40,18,85,  4,28,0,7
            // 13,40,18,3,   4,24,0,5
            // 13,40,18,81,  4,10,1,7
            // 13,40,18,72,  4,30,1,5
            // 13,40,18,24,  4,25,0,40 - motion on left side
            // 13,40,18,47,  4,28,0,56
            // 13,40,18,8,   4,32,0,40
            let value = {};
            if (msg.data[4] == 0) {
                value = msg.data[6];
                if (1 <= value && value <= 3) {
                    const actionLookup = {1: 'single', 2: 'double', 3: 'triple', 4: 'quadruple'};
                    return {action: actionLookup[value]};
                }
            } else if (msg.data[4] == 4) {
                value = msg.data[7];
                const sidelookup = {5: 'right', 7: 'right', 40: 'left', 56: 'left'};
                if (sidelookup[value]) {
                    msg.data.occupancy = 1;
                    const payload = converters.occupancy_with_timeout.convert(model, msg, publish, options, meta);
                    payload.action_side = sidelookup[value];
                    payload.side = sidelookup[value]; /* legacy: remove this line (replaced by action_side) */

                    return payload;
                }
            }
        },
    },
    konke_action: {
        cluster: 'genOnOff',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const value = msg.data['onOff'];
            const lookup = {128: 'single', 129: 'double', 130: 'hold'};
            return lookup[value] ? {action: lookup[value]} : null;
        },
    },
    xiaomi_curtain_position: {
        cluster: 'genAnalogOutput',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            let running = false;

            if (model.model === 'ZNCLDJ12LM' && msg.type === 'attributeReport' && [0, 2].includes(msg.data['presentValue'])) {
                // Incorrect reports from the device, ignore (re-read by onEvent of ZNCLDJ12LM)
                // https://github.com/Koenkk/zigbee-herdsman-converters/pull/1427#issuecomment-663862724
                return;
            }

            if (msg.data['61440']) {
                running = msg.data['61440'] !== 0;
            }

            let position = precisionRound(msg.data['presentValue'], 2);
            position = options.invert_cover ? 100 - position : position;
            return {position: position, running: running};
        },
    },
    xiaomi_curtain_options: {
        cluster: 'genBasic',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const data = msg.data['1025'];
            if (data) {
                return {
                    options: { // next values update only when curtain finished initial setup and knows current position
                        reverse_direction: data[2]=='\u0001',
                        hand_open: data[5]=='\u0000',
                    },
                };
            }
        },
    },
    xiaomi_operation_mode_basic: {
        cluster: 'genBasic',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const payload = {};
            if (['QBKG04LM', 'QBKG11LM', 'QBKG21LM'].includes(model.model)) {
                const mappingMode = {0x12: 'control_relay', 0xFE: 'decoupled'};
                const key = '65314';
                if (msg.data.hasOwnProperty(key)) {
                    payload.operation_mode = mappingMode[msg.data[key]];
                }
            } else if (['QBKG03LM', 'QBKG12LM', 'QBKG22LM'].includes(model.model)) {
                const mappingButton = {'65314': 'left', '65315': 'right'};
                const mappingMode = {0x12: 'control_left_relay', 0x22: 'control_right_relay', 0xFE: 'decoupled'};
                for (const key in mappingButton) {
                    if (msg.data.hasOwnProperty(key)) {
                        const mode = mappingMode[msg.data[key]];
                        payload[`operation_mode_${mappingButton[key]}`] = mode;
                    }
                }
            } else {
                throw new Error('Not supported');
            }

            return payload;
        },
    },
    xiaomi_operation_mode_opple: {
        cluster: 'aqaraOpple',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const mappingButton = {
                1: 'left',
                2: 'center',
                3: 'right',
            };
            const mappingMode = {
                0x01: 'control_relay',
                0x00: 'decoupled',
            };
            for (const key in mappingButton) {
                if (msg.endpoint.ID == key && msg.data.hasOwnProperty('512')) {
                    const payload = {};
                    const mode = mappingMode['512'];
                    payload[`operation_mode_${mappingButton[key]}`] = mode;
                    return payload;
                }
            }
        },
    },
    qlwz_letv8key_switch: {
        cluster: 'genMultistateInput',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const buttonLookup = {4: 'up', 2: 'down', 5: 'left', 3: 'right', 8: 'center', 1: 'back', 7: 'play', 6: 'voice'};
            const actionLookup = {0: 'hold', 1: 'single', 2: 'double', 3: 'tripple'};
            const button = buttonLookup[msg.endpoint.ID];
            const action = actionLookup[msg.data['presentValue']] || msg.data['presentValue'];
            if (button) {
                return {action: `${action}_${button}`};
            }
        },
    },
    aqara_opple_report: {
        cluster: 'aqaraOpple',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            // it is like xiaomi_battery_3v, but not parsed
            // https://github.com/Koenkk/zigbee-herdsman/blob/master/src/zcl/buffaloZcl.ts#L93
            // data: { '247': <Buffer 01 21 b8 0b 03 28 19 04 21 a8 13 05 21 44 01 06 24 02
            //                        00 00 00 00 08 21 11 01 0a 21 00 00 0c 20 01 64 10 00> }
            if (msg.data['247']) {
                const voltage = msg.data['247'][2] + msg.data['247'][3]*256;
                if (voltage) {
                    return {battery: toPercentage3V(voltage), voltage: voltage};
                }
            }

            if (msg.data['mode'] !== undefined) {
                const lookup = ['command', 'event'];
                return {operation_mode: lookup[msg.data['mode']]};
            }
        },
    },
    aqara_opple_multistate: {
        cluster: 'genMultistateInput',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (hasAlreadyProcessedMessage(msg)) return;
            const actionLookup = {0: 'hold', 255: 'release', 1: 'single', 2: 'double', 3: 'triple'};
            const button = msg.endpoint.ID;
            const value = msg.data.presentValue;
            clearTimeout(globalStore.getValue(msg.endpoint, 'timer'));

            // 0 = hold
            if (value === 0) {
                // Aqara Opple does not generate a release event when pressed for more than 5 seconds
                // After 5 seconds of not releasing we assume release.
                const timer = setTimeout(() => publish({action: `button_${button}_release`}), 5000);
                globalStore.putValue(msg.endpoint, 'timer', timer);
            }

            return {action: `button_${button}_${actionLookup[value]}`};
        },
    },
    aqara_opple_on: {
        cluster: 'genOnOff',
        type: 'commandOn',
        convert: (model, msg, publish, options, meta) => {
            if (hasAlreadyProcessedMessage(msg)) return;
            return {action: 'button_2_single'};
        },
    },
    aqara_opple_off: {
        cluster: 'genOnOff',
        type: 'commandOff',
        convert: (model, msg, publish, options, meta) => {
            if (hasAlreadyProcessedMessage(msg)) return;
            return {action: 'button_1_single'};
        },
    },
    aqara_opple_step: {
        cluster: 'genLevelCtrl',
        type: 'commandStep',
        convert: (model, msg, publish, options, meta) => {
            if (hasAlreadyProcessedMessage(msg)) return;
            const button = msg.data.stepmode === 0 ? '4' : '3';
            return {action: `button_${button}_single`};
        },
    },
    aqara_opple_stop: {
        cluster: 'genLevelCtrl',
        type: 'commandStop',
        convert: (model, msg, publish, options, meta) => {
            if (hasAlreadyProcessedMessage(msg)) return;
            if (globalStore.hasValue(msg.endpoint, 'button')) {
                const value = globalStore.getValue(msg.endpoint, 'button');
                const duration = Date.now() - value.start;
                const payload = {action: `button_${value.button}_release`, duration, action_duration: duration};
                if (!isLegacyEnabled(options)) delete payload.duration;
                return payload;
            }
        },
    },
    aqara_opple_move: {
        cluster: 'genLevelCtrl',
        type: 'commandMove',
        convert: (model, msg, publish, options, meta) => {
            if (hasAlreadyProcessedMessage(msg)) return;
            const button = msg.data.movemode === 0 ? '4' : '3';
            globalStore.putValue(msg.endpoint, 'button', {button, start: Date.now()});
            return {action: `button_${button}_hold`};
        },
    },
    aqara_opple_step_color_temp: {
        cluster: 'lightingColorCtrl',
        type: 'commandStepColorTemp',
        convert: (model, msg, publish, options, meta) => {
            if (hasAlreadyProcessedMessage(msg)) return;
            let action;
            if (model.model === 'WXCJKG12LM') {
                // for WXCJKG12LM model it's double click event on buttons 3 and 4
                action = (msg.data.stepmode === 1) ? '3_double' : '4_double';
            } else {
                // but for WXCJKG13LM model it's single click event on buttons 5 and 6
                action = (msg.data.stepmode === 1) ? '5_single' : '6_single';
            }
            return {action: `button_${action}`};
        },
    },
    aqara_opple_move_color_temp: {
        cluster: 'lightingColorCtrl',
        type: 'commandMoveColorTemp',
        convert: (model, msg, publish, options, meta) => {
            if (hasAlreadyProcessedMessage(msg)) return;
            const stop = msg.data.movemode === 0;
            let result = null;
            if (stop) {
                const button = globalStore.getValue(msg.endpoint, 'button').button;
                const duration = Date.now() - globalStore.getValue(msg.endpoint, 'button').start;
                result = {action: `button_${button}_release`, duration, action_duration: duration};
                if (!isLegacyEnabled(options)) delete result.duration;
            } else {
                const button = msg.data.movemode === 3 ? '6' : '5';
                result = {action: `button_${button}_hold`};
                globalStore.putValue(msg.endpoint, 'button', {button, start: Date.now()});
            }
            return result;
        },
    },
    keen_home_smart_vent_pressure: {
        cluster: 'msPressureMeasurement',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const pressure = msg.data.hasOwnProperty('measuredValue') ? msg.data.measuredValue : parseFloat(msg.data['32']) / 1000.0;
            return {pressure: calibrateAndPrecisionRoundOptions(pressure, options, 'pressure')};
        },
    },
    U02I007C01_contact: {
        cluster: 'ssIasZone',
        type: 'commandStatusChangeNotification',
        convert: (model, msg, publish, options, meta) => {
            const zoneStatus = msg.data.zonestatus;
            if (msg.endpoint.ID != 1) return;
            return {
                contact: !((zoneStatus & 1) > 0),
            };
        },
    },
    U02I007C01_water_leak: {
        cluster: 'ssIasZone',
        type: 'commandStatusChangeNotification',
        convert: (model, msg, publish, options, meta) => {
            const zoneStatus = msg.data.zonestatus;
            if (msg.endpoint.ID != 2) return;
            return {
                water_leak: (zoneStatus & 1) > 0,
            };
        },
    },
    heiman_pm25: {
        cluster: 'heimanSpecificPM25Measurement',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data['measuredValue']) {
                return {pm25: msg.data['measuredValue']};
            }
        },
    },
    heiman_hcho: {
        cluster: 'heimanSpecificFormaldehydeMeasurement',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data['measuredValue']) {
                return {hcho: parseFloat(msg.data['measuredValue']) / 100.0};
            }
        },
    },
    heiman_air_quality: {
        cluster: 'heimanSpecificAirQuality',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data['batteryState']) {
                const lookup = {
                    0: 'not_charging',
                    1: 'charging',
                    2: 'charged',
                };
                result['battery_state'] = lookup[msg.data['batteryState']];
            }
            if (msg.data['tvocMeasuredValue']) result['voc'] = msg.data['tvocMeasuredValue'];
            if (msg.data['aqiMeasuredValue']) result['aqi'] = msg.data['aqiMeasuredValue'];
            if (msg.data['pm10measuredValue']) result['pm10'] = msg.data['pm10measuredValue'];
            return result;
        },
    },
    scenes_recall_scene_65029: {
        cluster: 65029,
        type: ['raw'],
        convert: (model, msg, publish, options, meta) => {
            return {action: `scene_${msg.data[msg.data.length - 1]}`};
        },
    },
    scenes_recall_scene_65024: {
        cluster: 65024,
        type: ['raw'],
        convert: (model, msg, publish, options, meta) => {
            return {action: `scene_${msg.data[msg.data.length - 2] - 9}`};
        },
    },
    color_stop_raw: {
        cluster: 'lightingColorCtrl',
        type: ['raw'],
        convert: (model, msg, publish, options, meta) => {
            const payload = {action: postfixWithEndpointName(`color_stop`, msg, model)};
            addActionGroup(payload, msg, model);
            return payload;
        },
    },
    MFKZQ01LM_action_multistate: {
        cluster: 'genMultistateInput',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            /*
            Source: https://github.com/kirovilya/ioBroker.zigbee
                +---+
                | 2 |
            +---+---+---+
            | 4 | 0 | 1 |
            +---+---+---+
                |M5I|
                +---+
                | 3 |
                +---+
            Side 5 is with the MI logo, side 3 contains the battery door.
            presentValue = 0 = shake
            presentValue = 2 = wakeup
            presentValue = 3 = fly/fall
            presentValue = y + x * 8 + 64 = 90º Flip from side x on top to side y on top
            presentValue = x + 128 = 180º flip to side x on top
            presentValue = x + 256 = push/slide cube while side x is on top
            presentValue = x + 512 = double tap while side x is on top
            */
            const value = msg.data['presentValue'];
            let result = null;

            if (value === 0) result = {action: 'shake'};
            else if (value === 2) result = {action: 'wakeup'};
            else if (value === 3) result = {action: 'fall'};
            else if (value >= 512) result = {action: 'tap', side: value-512, action_side: value-512};
            else if (value >= 256) result = {action: 'slide', side: value-256, action_side: value-256};
            else if (value >= 128) result = {action: 'flip180', side: value-128, action_side: value-128};
            else if (value >= 64) {
                result = {
                    action: 'flip90', action_from_side: Math.floor((value-64) / 8), action_to_side: value % 8, action_side: value % 8,
                    from_side: Math.floor((value-64) / 8), to_side: value % 8, side: value % 8,
                };
            }

            if (result && !isLegacyEnabled(options)) {
                delete result.side;
                delete result.to_side;
                delete result.from_side;
            }

            return result ? result : null;
        },
    },
    MFKZQ01LM_action_analog: {
        cluster: 'genAnalogInput',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            /*
            Source: https://github.com/kirovilya/ioBroker.zigbee
            presentValue = rotation angle left < 0, right > 0
            */
            const value = msg.data['presentValue'];
            const result = {
                action: value < 0 ? 'rotate_left' : 'rotate_right',
                angle: Math.floor(value * 100) / 100,
                action_angle: Math.floor(value * 100) / 100,
            };

            if (!isLegacyEnabled(options)) delete result.angle;
            return result;
        },
    },
    tradfri_occupancy: {
        cluster: 'genOnOff',
        type: 'commandOnWithTimedOff',
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.ctrlbits === 1) return;
            const timeout = msg.data.ontime / 10;
            // Stop existing timer because motion is detected and set a new one.
            clearTimeout(globalStore.getValue(msg.endpoint, 'timer'));

            if (timeout !== 0) {
                const timer = setTimeout(() => publish({occupancy: false}), timeout * 1000);
                globalStore.putValue(msg.endpoint, 'timer', timer);
            }

            return {occupancy: true};
        },
    },
    PGC410EU_presence: {
        cluster: 'manuSpecificSmartThingsArrivalSensor',
        type: 'commandArrivalSensorNotify',
        convert: (model, msg, publish, options, meta) => {
            const useOptionsTimeout = options && options.hasOwnProperty('presence_timeout');
            const timeout = useOptionsTimeout ? options.presence_timeout : 100; // 100 seconds by default

            // Stop existing timer because motion is detected and set a new one.
            clearTimeout(globalStore.getValue(msg.endpoint, 'timer'));

            const timer = setTimeout(() => publish({presence: false}), timeout * 1000);
            globalStore.putValue(msg.endpoint, 'timer', timer);

            return {presence: true};
        },
    },
    STS_PRS_251_presence: {
        cluster: 'genBinaryInput',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const useOptionsTimeout = options && options.hasOwnProperty('presence_timeout');
            const timeout = useOptionsTimeout ? options.presence_timeout : 100; // 100 seconds by default

            // Stop existing timer because motion is detected and set a new one.
            clearTimeout(globalStore.getValue(msg.endpoint, 'timer'));

            const timer = setTimeout(() => publish({presence: false}), timeout * 1000);
            globalStore.putValue(msg.endpoint, 'timer', timer);

            return {presence: true};
        },
    },
    E1745_requested_brightness: {
        // Possible values are 76 (30%) or 254 (100%)
        cluster: 'genLevelCtrl',
        type: 'commandMoveToLevelWithOnOff',
        convert: (model, msg, publish, options, meta) => {
            return {
                requested_brightness_level: msg.data.level,
                requested_brightness_percent: Math.round(msg.data.level / 254 * 100),
            };
        },
    },
    xiaomi_bulb_interval: {
        cluster: 'genBasic',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data['65281']) {
                const data = msg.data['65281'];
                return {
                    state: data['100'] === 1 ? 'ON' : 'OFF',
                    brightness: data['101'],
                    color_temp: data['102'],
                };
            }
        },
    },
    heiman_scenes: {
        cluster: 'heimanSpecificScenes',
        type: ['commandAtHome', 'commandGoOut', 'commandCinema', 'commandRepast', 'commandSleep'],
        convert: (model, msg, publish, options, meta) => {
            const lookup = {
                'commandCinema': 'cinema',
                'commandAtHome': 'at_home',
                'commandSleep': 'sleep',
                'commandGoOut': 'go_out',
                'commandRepast': 'repast',
            };
            if (lookup.hasOwnProperty(msg.type)) return {action: lookup[msg.type]};
        },
    },
    javis_lock_report: {
        cluster: 'genBasic',
        type: 'attributeReport',
        convert: (model, msg, publish, options, meta) => {
            const lookup = {
                0: 'pairing',
                1: 'keypad',
                2: 'rfid_card_unlock',
                3: 'touch_unlock',
            };
            const data = utf8FromStr(msg['data']['16896']);
            return {
                action: 'unlock',
                action_user: data[3],
                action_source: data[5],
                action_source_name: lookup[data[5]],
            };
        },
    },
    diyruz_freepad_config: {
        cluster: 'genOnOffSwitchCfg',
        type: ['readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const button = getKey(model.endpoint(msg.device), msg.endpoint.ID);
            const {switchActions, switchType} = msg.data;
            const switchTypesLookup = ['toggle', 'momentary', 'multifunction'];
            const switchActionsLookup = ['on', 'off', 'toggle'];
            return {
                [`switch_type_${button}`]: switchTypesLookup[switchType],
                [`switch_actions_${button}`]: switchActionsLookup[switchActions],
            };
        },
    },
    diyruz_geiger: {
        cluster: 'msIlluminanceMeasurement',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            return {
                radioactive_events_per_minute: msg.data['61441'],
                radiation_dose_per_hour: msg.data['61442'],
            };
        },
    },
    diyruz_geiger_config: {
        cluster: 'msIlluminanceLevelSensing',
        type: 'readResponse',
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.hasOwnProperty(0xF001)) {
                result.led_feedback = ['OFF', 'ON'][msg.data[0xF001]];
            }
            if (msg.data.hasOwnProperty(0xF002)) {
                result.buzzer_feedback = ['OFF', 'ON'][msg.data[0xF002]];
            }
            if (msg.data.hasOwnProperty(0xF000)) {
                result.sensitivity = msg.data[0xF000];
            }
            if (msg.data.hasOwnProperty(0xF003)) {
                result.sensors_count = msg.data[0xF003];
            }
            if (msg.data.hasOwnProperty(0xF004)) {
                result.sensors_type = ['СБМ-20/СТС-5/BOI-33', 'СБМ-19/СТС-6', 'Others'][msg.data[0xF004]];
            }
            if (msg.data.hasOwnProperty(0xF005)) {
                result.alert_threshold = msg.data[0xF005];
            }
            return result;
        },
    },
    diyruz_airsense_config_co2: {
        cluster: 'msCO2',
        type: 'readResponse',
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.hasOwnProperty(0x0203)) {
                result.led_feedback = ['OFF', 'ON'][msg.data[0x0203]];
            }
            if (msg.data.hasOwnProperty(0x0202)) {
                result.enable_abc = ['OFF', 'ON'][msg.data[0x0202]];
            }
            if (msg.data.hasOwnProperty(0x0204)) {
                result.threshold1 = msg.data[0x0204];
            }
            if (msg.data.hasOwnProperty(0x0205)) {
                result.threshold2 = msg.data[0x0205];
            }
            return result;
        },
    },
    diyruz_airsense_config_temp: {
        cluster: 'msTemperatureMeasurement',
        type: 'readResponse',
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.hasOwnProperty(0x0210)) {
                result.temperature_offset = msg.data[0x0210];
            }
            return result;
        },
    },
    diyruz_airsense_config_pres: {
        cluster: 'msPressureMeasurement',
        type: 'readResponse',
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.hasOwnProperty(0x0210)) {
                result.pressure_offset = msg.data[0x0210];
            }
            return result;
        },

    },
    diyruz_airsense_config_hum: {
        cluster: 'msRelativeHumidity',
        type: 'readResponse',
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.hasOwnProperty(0x0210)) {
                result.humidity_offset = msg.data[0x0210];
            }
            return result;
        },
    },
    JTQJBF01LMBW_gas_density: {
        cluster: 'genBasic',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const data = msg.data;
            if (data && data['65281']) {
                const basicAttrs = data['65281'];
                if (basicAttrs.hasOwnProperty('100')) {
                    return {gas_density: basicAttrs['100']};
                }
            }
        },
    },
    JTYJGD01LMBW_smoke_density: {
        cluster: 'genBasic',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const data = msg.data;
            if (data && data['65281']) {
                const basicAttrs = data['65281'];
                if (basicAttrs.hasOwnProperty('100')) {
                    return {smoke_density: basicAttrs['100']};
                }
            }
        },
    },
    JTQJBF01LMBW_sensitivity: {
        cluster: 'ssIasZone',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const data = msg.data;
            const lookup = {'1': 'low', '2': 'medium', '3': 'high'};

            if (data && data.hasOwnProperty('65520')) {
                const value = data['65520'];
                if (value && value.startsWith('0x020')) {
                    return {
                        sensitivity: lookup[value.charAt(5)],
                    };
                }
            }
        },
    },
    DJT11LM_vibration: {
        cluster: 'closuresDoorLock',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};

            if (msg.data['85']) {
                const vibrationLookup = {1: 'vibration', 2: 'tilt', 3: 'drop'};
                result.action = vibrationLookup[msg.data['85']];
            }

            if (msg.data['1283']) {
                result.angle = msg.data['1283'];
            }

            if (msg.data['1285']) {
                // https://github.com/dresden-elektronik/deconz-rest-plugin/issues/748#issuecomment-419669995
                // Only first 2 bytes are relevant.
                const data = (msg.data['1285'] >> 8);
                // Swap byte order
                result.strength = ((data & 0xFF) << 8) | ((data >> 8) & 0xFF);
            }

            if (msg.data['1288']) {
                const data = msg.data['1288'];

                // array interpretation:
                // 12 bit two's complement sign extended integer
                // data[1][bit0..bit15] : x
                // data[1][bit16..bit31]: y
                // data[0][bit0..bit15] : z
                // left shift first to preserve sign extension for 'x'
                const x = ((data['1'] << 16) >> 16);
                const y = (data['1'] >> 16);
                // left shift first to preserve sign extension for 'z'
                const z = ((data['0'] << 16) >> 16);

                // calculate angle
                result.angle_x = Math.round(Math.atan(x/Math.sqrt(y*y+z*z)) * 180 / Math.PI);
                result.angle_y = Math.round(Math.atan(y/Math.sqrt(x*x+z*z)) * 180 / Math.PI);
                result.angle_z = Math.round(Math.atan(z/Math.sqrt(x*x+y*y)) * 180 / Math.PI);

                // calculate absolulte angle
                const R = Math.sqrt(x * x + y * y + z * z);
                result.angle_x_absolute = Math.round((Math.acos(x / R)) * 180 / Math.PI);
                result.angle_y_absolute = Math.round((Math.acos(y / R)) * 180 / Math.PI);
            }

            return result;
        },
    },
    DJT12LM_vibration: {
        cluster: 'genOnOff',
        type: 'commandOn',
        convert: (model, msg, publish, options, meta) => {
            return {action: 'vibration'};
        },
    },
    CC2530ROUTER_led: {
        cluster: 'genOnOff',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            return {led: msg.data['onOff'] === 1};
        },
    },
    CC2530ROUTER_meta: {
        cluster: 'genBinaryValue',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const data = msg.data;
            return {
                description: data['description'],
                type: data['inactiveText'],
                rssi: data['presentValue'],
            };
        },
    },
    DNCKAT_S00X_buttons: {
        cluster: 'genOnOff',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const action = msg.data['onOff'] === 1 ? 'release' : 'hold';
            const payload = {action: postfixWithEndpointName(action, msg, model)};

            if (isLegacyEnabled(options)) {
                const key = `button_${getKey(model.endpoint(msg.device), msg.endpoint.ID)}`;
                payload[key] = action;
            }

            return payload;
        },
    },
    xiaomi_on_off_ignore_endpoint_4_5_6: {
        cluster: 'genOnOff',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            // Xiaomi wall switches use endpoint 4, 5 or 6 to indicate an action on the button so we have to skip that.
            if (msg.data.hasOwnProperty('onOff') && ![4, 5, 6].includes(msg.endpoint.ID)) {
                const property = postfixWithEndpointName('state', msg, model);
                return {[property]: msg.data['onOff'] === 1 ? 'ON' : 'OFF'};
            }
        },
    },
    hue_motion_sensitivity: {
        cluster: 'msOccupancySensing',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.hasOwnProperty('48')) {
                const lookup = ['low', 'medium', 'high'];
                return {motion_sensitivity: lookup[msg.data['48']]};
            }
        },
    },
    // #endregion

    /**
     * TODO: Converters to be checked
     */
    SP600_power: {
        cluster: 'seMetering',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (meta.device.dateCode === '20160120') {
                // Cannot use metering_power, divisor/multiplier is not according to ZCL.
                // https://github.com/Koenkk/zigbee2mqtt/issues/2233
                // https://github.com/Koenkk/zigbee-herdsman-converters/issues/915

                const result = {};
                if (msg.data.hasOwnProperty('instantaneousDemand')) {
                    result.power = msg.data['instantaneousDemand'];
                }
                // Summation is reported in Watthours
                if (msg.data.hasOwnProperty('currentSummDelivered')) {
                    const data = msg.data['currentSummDelivered'];
                    const value = (parseInt(data[0]) << 32) + parseInt(data[1]);
                    result.energy = value / 1000.0;
                }
                return result;
            } else {
                return converters.metering_power.convert(model, msg, publish, options, meta);
            }
        },
    },
    color_colortemp: {
        cluster: 'lightingColorCtrl',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};

            if (msg.data.hasOwnProperty('colorTemperature')) {
                result.color_temp = msg.data['colorTemperature'];
            }

            if (msg.data.hasOwnProperty('colorMode')) {
                result.color_mode = msg.data['colorMode'];
            }

            if (
                msg.data.hasOwnProperty('currentX') || msg.data.hasOwnProperty('currentY') ||
                msg.data.hasOwnProperty('currentSaturation') || msg.data.hasOwnProperty('currentHue') ||
                msg.data.hasOwnProperty('enhancedCurrentHue')
            ) {
                result.color = {};

                if (msg.data.hasOwnProperty('currentX')) {
                    result.color.x = precisionRound(msg.data['currentX'] / 65535, 4);
                }

                if (msg.data.hasOwnProperty('currentY')) {
                    result.color.y = precisionRound(msg.data['currentY'] / 65535, 4);
                }

                if (msg.data.hasOwnProperty('currentSaturation')) {
                    result.color.saturation = precisionRound(msg.data['currentSaturation'] / 2.54, 0);
                }

                if (msg.data.hasOwnProperty('currentHue')) {
                    result.color.hue = precisionRound((msg.data['currentHue'] * 360) / 254, 0);
                }

                if (msg.data.hasOwnProperty('enhancedCurrentHue')) {
                    result.color.hue = precisionRound(msg.data['enhancedCurrentHue'] / (65535 / 360), 1);
                }
            }

            return result;
        },
    },
    xiaomi_lock_report: {
        cluster: 'genBasic',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data['65328']) {
                const data = msg.data['65328'];
                const state = data.substr(2, 2);
                const action = data.substr(4, 2);
                const keynum = data.substr(6, 2);
                if (state == 11) {
                    if (action == 1) {
                        // unknown key
                        return {keyerror: true, inserted: 'unknown'};
                    }
                    if (action == 3) {
                        // explicitly disabled key (i.e. reported lost)
                        return {keyerror: true, inserted: keynum};
                    }
                    if (action == 7) {
                        // strange object introduced into the cylinder (e.g. a lock pick)
                        return {keyerror: true, inserted: 'strange'};
                    }
                }
                if (state == 12) {
                    if (action == 1) {
                        return {inserted: keynum};
                    }
                    if (action == 11) {
                        return {forgotten: keynum};
                    }
                }
            }
        },
    },
    peanut_electrical: {
        cluster: 'haElectricalMeasurement',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            const deviceID = msg.device.ieeeAddr;

            // initialize stored defaults with observed values
            if (!store[deviceID]) {
                store[deviceID] = {
                    acVoltageMultiplier: 180, acVoltageDivisor: 39321, acCurrentMultiplier: 72,
                    acCurrentDivisor: 39321, acPowerMultiplier: 10255, acPowerDivisor: 39321,
                };
            }

            // if new multipliers/divisors come in, replace prior values or defaults
            Object.keys(store[deviceID]).forEach((key) => {
                if (msg.data.hasOwnProperty(key)) {
                    store[deviceID][key] = msg.data[key];
                }
            });

            // if raw measurement comes in, apply stored/default multiplier and divisor
            if (msg.data.hasOwnProperty('rmsVoltage')) {
                result.voltage = (msg.data['rmsVoltage'] * store[deviceID].acVoltageMultiplier /
                    store[deviceID].acVoltageDivisor).toFixed(2);
            }

            if (msg.data.hasOwnProperty('rmsCurrent')) {
                result.current = (msg.data['rmsCurrent'] * store[deviceID].acCurrentMultiplier /
                    store[deviceID].acCurrentDivisor).toFixed(2);
            }

            if (msg.data.hasOwnProperty('activePower')) {
                result.power = (msg.data['activePower'] * store[deviceID].acPowerMultiplier /
                    store[deviceID].acPowerDivisor).toFixed(2);
            }

            return result;
        },
    },
    _324131092621_notification: {
        cluster: 'manuSpecificPhilips',
        type: 'commandHueNotification',
        convert: (model, msg, publish, options, meta) => {
            const multiplePressTimeout = options && options.hasOwnProperty('multiple_press_timeout') ?
                options.multiple_press_timeout : 0.25;

            const getPayload = function(button, pressType, pressDuration, pressCounter,
                brightnessSend, brightnessValue) {
                const payLoad = {};
                payLoad['action'] = `${button}-${pressType}`;
                payLoad['duration'] = pressDuration / 1000;
                if (pressCounter) {
                    payLoad['counter'] = pressCounter;
                }
                if (brightnessSend) {
                    payLoad['brightness'] = store[deviceID].brightnessValue;
                }
                return payLoad;
            };

            const deviceID = msg.device.ieeeAddr;
            let button = null;
            switch (msg.data['button']) {
            case 1:
                button = 'on';
                break;
            case 2:
                button = 'up';
                break;
            case 3:
                button = 'down';
                break;
            case 4:
                button = 'off';
                break;
            }
            let type = null;
            switch (msg.data['type']) {
            case 0:
                type = 'press';
                break;
            case 1:
                type = 'hold';
                break;
            case 2:
            case 3:
                type = 'release';
                break;
            }

            const brightnessEnabled = options && options.hasOwnProperty('send_brightess') ?
                options.send_brightess : true;
            const brightnessSend = brightnessEnabled && button && (button == 'up' || button == 'down');

            // Initialize store
            if (!store[deviceID]) {
                store[deviceID] = {pressStart: null, pressType: null,
                    delayedButton: null, delayedBrightnessSend: null, delayedType: null,
                    delayedCounter: 0, delayedTimerStart: null, delayedTimer: null};
                if (brightnessEnabled) {
                    store[deviceID].brightnessValue = 255;
                    store[deviceID].brightnessSince = null;
                    store[deviceID].brightnessDirection = null;
                }
            }

            if (button && type) {
                if (type == 'press') {
                    store[deviceID].pressStart = Date.now();
                    store[deviceID].pressType = 'press';
                    if (brightnessSend) {
                        const newValue = store[deviceID].brightnessValue + (button === 'up' ? 32 : -32);
                        store[deviceID].brightnessValue = numberWithinRange(newValue, 1, 255);
                    }
                } else if (type == 'hold') {
                    store[deviceID].pressType = 'hold';
                    if (brightnessSend) {
                        holdUpdateBrightness324131092621(deviceID);
                        store[deviceID].brightnessSince = Date.now();
                        store[deviceID].brightnessDirection = button;
                    }
                } else if (type == 'release') {
                    if (brightnessSend) {
                        store[deviceID].brightnessSince = null;
                        store[deviceID].brightnessDirection = null;
                    }
                    if (store[deviceID].pressType == 'hold') {
                        store[deviceID].pressType += '-release';
                    }
                }
                if (type == 'press') {
                    // pressed different button
                    if (store[deviceID].delayedTimer && (store[deviceID].delayedButton != button)) {
                        clearTimeout(store[deviceID].delayedTimer);
                        store[deviceID].delayedTimer = null;
                        publish(getPayload(store[deviceID].delayedButton,
                            store[deviceID].delayedType, 0, store[deviceID].delayedCounter,
                            store[deviceID].delayedBrightnessSend,
                            store[deviceID].brightnessValue));
                    }
                } else {
                    // released after press: start timer
                    if (store[deviceID].pressType == 'press') {
                        if (store[deviceID].delayedTimer) {
                            clearTimeout(store[deviceID].delayedTimer);
                            store[deviceID].delayedTimer = null;
                        } else {
                            store[deviceID].delayedCounter = 0;
                        }
                        store[deviceID].delayedButton = button;
                        store[deviceID].delayedBrightnessSend = brightnessSend;
                        store[deviceID].delayedType = store[deviceID].pressType;
                        store[deviceID].delayedCounter++;
                        store[deviceID].delayedTimerStart = Date.now();
                        store[deviceID].delayedTimer = setTimeout(() => {
                            publish(getPayload(store[deviceID].delayedButton,
                                store[deviceID].delayedType, 0, store[deviceID].delayedCounter,
                                store[deviceID].delayedBrightnessSend,
                                store[deviceID].brightnessValue));
                            store[deviceID].delayedTimer = null;
                        }, multiplePressTimeout * 1000);
                    } else {
                        const pressDuration =
                            (store[deviceID].pressType == 'hold' || store[deviceID].pressType == 'hold-release') ?
                                Date.now() - store[deviceID].pressStart : 0;
                        return getPayload(button,
                            store[deviceID].pressType, pressDuration, null, brightnessSend,
                            store[deviceID].brightnessValue);
                    }
                }
            }

            return {};
        },
    },
    thermostat_weekly_schedule_rsp: {
        cluster: 'hvacThermostat',
        type: ['commandGetWeeklyScheduleRsp'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            const key = postfixWithEndpointName('weekly_schedule', msg, model);
            result[key] = {};
            if (typeof msg.data['dayofweek'] == 'number') {
                result[key][msg.data['dayofweek']] = msg.data;
                for (const elem of result[key][msg.data['dayofweek']]['transitions']) {
                    if (typeof elem['heatSetpoint'] == 'number') {
                        elem['heatSetpoint'] /= 100;
                    }
                    if (typeof elem['coolSetpoint'] == 'number') {
                        elem['coolSetpoint'] /= 100;
                    }
                }
            }
            return result;
        },
    },
    generic_fan_mode: {
        cluster: 'hvacFanCtrl',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const key = getKey(common.fanMode, msg.data.fanMode);
            return {fan_mode: key, fan_state: key === 'off' ? 'OFF' : 'ON'};
        },
    },
    SZ_ESW01_AU_power: {
        cluster: 'seMetering',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.hasOwnProperty('instantaneousDemand')) {
                return {power: precisionRound(msg.data['instantaneousDemand'] / 1000, 2)};
            }
        },
    },
    ZNMS12LM_low_battery: {
        cluster: 'genPowerCfg',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (typeof msg.data['batteryAlarmMask'] == 'number') {
                return {battery_low: msg.data['batteryAlarmMask'] === 1};
            }
        },
    },
    DTB190502A1_parse: {
        cluster: 'genOnOff',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const lookupKEY = {
                '0': 'KEY_SYS',
                '1': 'KEY_UP',
                '2': 'KEY_DOWN',
                '3': 'KEY_NONE',
            };
            const lookupLED = {
                '0': 'OFF',
                '1': 'ON',
            };
            return {
                cpu_temperature: precisionRound(msg.data['41361'], 2),
                key_state: lookupKEY[msg.data['41362']],
                led_state: lookupLED[msg.data['41363']],
            };
        },
    },
    terncy_knob: {
        cluster: 'manuSpecificClusterAduroSmart',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (typeof msg.data['27'] === 'number') {
                return {
                    action: 'rotate',
                    direction: (msg.data['27'] > 0 ? 'clockwise' : 'counterclockwise'),
                    number: (Math.abs(msg.data['27']) / 12),
                };
            }
        },
    },
    CCTSwitch_D0001_move_to_level_recall: {
        cluster: 'genLevelCtrl',
        type: ['commandMoveToLevel', 'commandMoveToLevelWithOnOff'],
        convert: (model, msg, publish, options, meta) => {
            // wrap the messages from button2 and button4 into a single function
            // button2 always sends "commandMoveToLevel"
            // button4 sends two messages, with "commandMoveToLevelWithOnOff" coming first in the sequence
            //         so that's the one we key off of to indicate "button4". we will NOT print it in that case,
            //         instead it will be returned as part of the second sequence with
            //         CCTSwitch_D0001_move_to_colortemp_recall below.

            const deviceID = msg.device.ieeeAddr;
            if (!store[deviceID]) {
                store[deviceID] = {lastClk: null, lastSeq: -10, lastBrightness: null,
                    lastMoveLevel: null, lastColorTemp: null};
            }

            let clk = 'brightness';
            let cmd = null;
            const payload = {brightness: msg.data.level, transition: parseFloat(msg.data.transtime/10.0)};
            if ( msg.type == 'commandMoveToLevel' ) {
                // pressing the brightness button increments/decrements from 13-254.
                // when it reaches the end (254) it will start decrementing by a step,
                // and vice versa.
                const direction = msg.data.level > store[deviceID].lastBrightness ? 'up' : 'down';
                cmd = `${clk}_${direction}`;
                store[deviceID].lastBrightness = msg.data.level;
            } else if ( msg.type == 'commandMoveToLevelWithOnOff' ) {
                // This is the 'start' of the 4th button sequence.
                clk = 'memory';
                store[deviceID].lastMoveLevel = msg.data.level;
                store[deviceID].lastClk = clk;
            }

            if ( clk != 'memory' ) {
                store[deviceID].lastSeq = msg.meta.zclTransactionSequenceNumber;
                store[deviceID].lastClk = clk;
                payload.click = clk;
                payload.action = cmd;
                return payload;
            }
        },
    },
    CCTSwitch_D0001_move_to_colortemp_recall: {
        cluster: 'lightingColorCtrl',
        type: 'commandMoveToColorTemp',
        convert: (model, msg, publish, options, meta) => {
            // both button3 and button4 send the command "commandMoveToColorTemp"
            // in order to distinguish between the buttons, use the sequence number and the previous command
            // to determine if this message was immediately preceded by "commandMoveToLevelWithOnOff"
            // if this command follows a "commandMoveToLevelWithOnOff", then it's actually button4's second message
            // and we can ignore it entirely
            const deviceID = msg.device.ieeeAddr;
            if (!store[deviceID]) {
                store[deviceID] = {lastClk: null, lastSeq: -10, lastBrightness: null,
                    lastMoveLevel: null, lastColorTemp: null};
            }
            const lastClk = store[deviceID].lastClk;
            const lastSeq = store[deviceID].lastSeq;

            const seq = msg.meta.zclTransactionSequenceNumber;
            let clk = 'colortemp';
            const payload = {color_temp: msg.data.colortemp, transition: parseFloat(msg.data.transtime/10.0)};

            // because the remote sends two commands for button4, we need to look at the previous command and
            // see if it was the recognized start command for button4 - if so, ignore this second command,
            // because it's not really button3, it's actually button4
            if ( lastClk == 'memory' ) {
                payload.click = lastClk;
                payload.action = 'recall';
                payload.brightness = store[deviceID].lastMoveLevel;

                // ensure the "last" message was really the message prior to this one
                // accounts for missed messages (gap >1) and for the remote's rollover from 127 to 0
                if ( (seq == 0 && lastSeq == 127 ) || ( seq - lastSeq ) == 1 ) {
                    clk = null;
                }
            } else {
                // pressing the color temp button increments/decrements from 153-370K.
                // when it reaches the end (370) it will start decrementing by a step,
                // and vice versa.
                const direction = msg.data.colortemp > store[deviceID].lastColorTemp ? 'up' : 'down';
                const cmd = `${clk}_${direction}`;
                payload.click = clk;
                payload.action = cmd;
                store[deviceID].lastColorTemp = msg.data.colortemp;
            }

            if ( clk != null ) {
                store[deviceID].lastSeq = msg.meta.zclTransactionSequenceNumber;
                store[deviceID].lastClk = clk;
                return payload;
            }
        },
    },
    CCTSwitch_D0001_brightness_updown_hold_release: {
        cluster: 'genLevelCtrl',
        type: ['commandMove', 'commandStop'],
        convert: (model, msg, publish, options, meta) => {
            const deviceID = msg.device.ieeeAddr;
            if (!store[deviceID]) {
                store[deviceID] = {};
            }
            const stop = msg.type === 'commandStop' ? true : false;
            let direction = null;
            const clk = 'brightness';
            const payload = {click: clk};
            if (stop) {
                direction = store[deviceID].direction;
                const duration = Date.now() - store[deviceID].start;
                payload.action = `${clk}_${direction}_release`;
                payload.duration = duration;
            } else {
                direction = msg.data.movemode === 1 ? 'down' : 'up';
                payload.action = `${clk}_${direction}_hold`;
                // store button and start moment
                store[deviceID].direction = direction;
                payload.rate = msg.data.rate;
                store[deviceID].start = Date.now();
            }
            return payload;
        },
    },
    CCTSwitch_D0001_colortemp_updown_hold_release: {
        cluster: 'lightingColorCtrl',
        type: 'commandMoveColorTemp',
        convert: (model, msg, publish, options, meta) => {
            const deviceID = msg.device.ieeeAddr;
            if (!store[deviceID]) {
                store[deviceID] = {};
            }
            const stop = msg.data.movemode === 0;
            let direction = null;
            const clk = 'colortemp';
            const payload = {click: clk, rate: msg.data.rate};
            if (stop) {
                direction = store[deviceID].direction;
                const duration = Date.now() - store[deviceID].start;
                payload.action = `${clk}_${direction}_release`;
                payload.duration = duration;
            } else {
                direction = msg.data.movemode === 3 ? 'down' : 'up';
                payload.action = `${clk}_${direction}_hold`;
                payload.rate = msg.data.rate;
                // store button and start moment
                store[deviceID].direction = direction;
                store[deviceID].start = Date.now();
            }
            return payload;
        },
    },
    wiser_device_info: {
        cluster: 'wiserDeviceInfo',
        type: 'attributeReport',
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            const data = msg.data['deviceInfo'].split(',');
            if (data[0] === 'ALG') {
                // TODO What is ALG
                const alg = data.slice(1);
                result['ALG'] = alg.join(',');
                result['occupied_heating_setpoint'] = alg[2]/10;
                result['local_temperature'] = alg[3]/10;
                result['pi_heating_demand'] = parseInt(alg[9]);
            } else if (data[0] === 'ADC') {
                // TODO What is ADC
                const adc = data.slice(1);
                result['ADC'] = adc.join(',');
                result['occupied_heating_setpoint'] = adc[5]/100;
                result['local_temperature'] = adc[3]/10;
            } else if (data[0] === 'UI') {
                if (data[1] === 'BoostUp') {
                    result['boost'] = 'Up';
                } else if (data[1] === 'BoostDown') {
                    result['boost'] = 'Down';
                } else {
                    result['boost'] = 'None';
                }
            } else if (data[0] === 'MOT') {
                // Info about the motor
                result['MOT'] = data[1];
            }
            return result;
        },
    },
    wiser_itrv_battery: {
        cluster: 'genPowerCfg',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (typeof msg.data['batteryVoltage'] == 'number') {
                const battery = {max: 30, min: 22};
                const voltage = msg.data['batteryVoltage'];
                result.battery = toPercentage(voltage, battery.min, battery.max);
                result.voltage = voltage / 10;
            }
            if (typeof msg.data['batteryAlarmState'] == 'number') {
                const battLow = msg.data['batteryAlarmState'];
                if (battLow) {
                    result['battery_low'] = true;
                } else {
                    result['battery_low'] = false;
                }
            }
            return result;
        },
    },
    tuya_led_controller: {
        cluster: 'lightingColorCtrl',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};

            if (msg.data.hasOwnProperty('colorTemperature')) {
                const value = Number(msg.data['colorTemperature']);
                // Mapping from
                // Warmwhite 0 -> 255 Coldwhite
                // to Homeassistant: Coldwhite 153 -> 500 Warmwight
                result.color_temp = Math.round(-1.36 * value + 500);
            }

            if (msg.data.hasOwnProperty('tuyaBrightness')) {
                result.brightness = msg.data['tuyaBrightness'];
            }

            result.color = {};

            if (msg.data.hasOwnProperty('currentHue')) {
                result.color.h = precisionRound((msg.data['currentHue'] * 360) / 254, 0);
            }

            if (msg.data.hasOwnProperty('currentSaturation')) {
                result.color.s = precisionRound(msg.data['currentSaturation'] / 2.54, 0);
            }

            return result;
        },
    },
    tuya_thermostat_weekly_schedule: {
        cluster: 'manuSpecificTuya',
        type: ['commandGetData', 'commandSetDataResponse'],
        convert: (model, msg, publish, options, meta) => {
            const dp = msg.data.dp;
            const value = tuyaGetDataValue(msg.data.datatype, msg.data.data);

            const thermostatMeta = utils.getMetaValue(msg.endpoint, model, 'thermostat');
            const firstDayDpId = thermostatMeta.weeklyScheduleFirstDayDpId;
            const maxTransitions = thermostatMeta.weeklyScheduleMaxTransitions;
            let dataOffset = 0;
            let conversion = 'generic';

            function dataToTransitions(data, maxTransitions, offset) {
                // Later it is possible to move converter to meta or to other place outside if other type of converter
                // will be needed for other device. Currently this converter is based on ETOP HT-08 thermostat.
                // see also toZigbee.tuya_thermostat_weekly_schedule()
                function dataToTransition(data, index) {
                    return {
                        transitionTime: (data[index+0] << 8) + data [index+1],
                        heatSetpoint: (parseFloat((data[index+2] << 8) + data [index+3]) / 10.0).toFixed(1),
                    };
                }
                const result = [];
                for (let i = 0; i < maxTransitions; i++) {
                    result.push(dataToTransition(data, i * 4 + offset));
                }
                return result;
            }

            if (thermostatMeta.hasOwnProperty('weeklyScheduleConversion')) {
                conversion = thermostatMeta.weeklyScheduleConversion;
            }
            if (conversion == 'saswell') {
                // Saswell has scheduling mode in the first byte
                dataOffset = 1;
            }
            if (dp >= firstDayDpId && dp < firstDayDpId+7) {
                const dayOfWeek = dp - firstDayDpId + 1;
                return {
                    // Same as in hvacThermostat:getWeeklyScheduleRsp hvacThermostat:setWeeklySchedule cluster format
                    weekly_schedule: {
                        [dayOfWeek]: {
                            dayofweek: dayOfWeek,
                            numoftrans: maxTransitions,
                            mode: 1, // bits: 0-heat present, 1-cool present (dec: 1-heat,2-cool,3-heat+cool)
                            transitions: dataToTransitions(value, maxTransitions, dataOffset),
                        },
                    },
                };
            }
        },
    },
    tuya_cover: {
        cluster: 'manuSpecificTuya',
        type: ['commandSetDataResponse', 'commandGetData'],
        convert: (model, msg, publish, options, meta) => {
            const dp = msg.data.dp;
            const value = tuyaGetDataValue(msg.data.datatype, msg.data.data);

            // Protocol description
            // https://github.com/Koenkk/zigbee-herdsman-converters/issues/1159#issuecomment-614659802

            switch (dp) {
            case common.TuyaDataPoints.state: // Confirm opening/closing/stopping (triggered from Zigbee)
            case common.TuyaDataPoints.coverPosition: // Started moving to position (triggered from Zigbee)
            case common.TuyaDataPoints.coverChange: // Started moving (triggered by transmitter oder pulling on curtain)
                return {'running': true};
            case common.TuyaDataPoints.coverArrived: { // Arrived at position
                const position = options.invert_cover ? value : 100 - value;

                if (position > 0 && position <= 100) {
                    return {running: false, position: position};
                } else if (position == 0) { // Report fully closed
                    return {running: false, position: position};
                } else {
                    return {running: false}; // Not calibrated yet, no position is available
                }
            }
            case common.TuyaDataPoints.config: // 0x01 0x05: Returned by configuration set; ignore
                break;
            default: // Unknown code
                console.log(`owvfni3: Unhandled DP #${dp}: ${JSON.stringify(msg.data)}`);
            }
        },
    },
    almond_click: {
        cluster: 'ssIasAce',
        type: ['commandArm'],
        convert: (model, msg, publish, options, meta) => {
            const action = msg.data['armmode'];
            delete msg.data['armmode'];
            const lookup = {
                3: {action: 'single'}, // single click
                0: {action: 'double'}, // double
                2: {action: 'long'}, // hold
            };

            // Workaround to ignore duplicated (false) presses that
            // are 100ms apart, since the button often generates
            // multiple duplicated messages for a single click event.
            const deviceID = msg.device.ieeeAddr;
            if (!store[deviceID]) {
                store[deviceID] = {since: 0};
            }

            const now = Date.now();
            const since = store[deviceID].since;

            if ((now-since)>100) {
                store[deviceID].since = now;
                return lookup[action] ? lookup[action] : null;
            } else {
                return;
            }
        },
    },
    ubisys_c4_scenes: {
        cluster: 'genScenes',
        type: 'commandRecall',
        convert: (model, msg, publish, options, meta) => {
            return {action: `${msg.endpoint.ID}_scene_${msg.data.groupid}_${msg.data.sceneid}`};
        },
    },
    ubisys_c4_onoff: {
        cluster: 'genOnOff',
        type: ['commandOn', 'commandOff', 'commandToggle'],
        convert: (model, msg, publish, options, meta) => {
            return {action: `${msg.endpoint.ID}_${msg.type.substr(7).toLowerCase()}`};
        },
    },
    ubisys_c4_level: {
        cluster: 'genLevelCtrl',
        type: ['commandMoveWithOnOff', 'commandStopWithOnOff'],
        convert: (model, msg, publish, options, meta) => {
            switch (msg.type) {
            case 'commandMoveWithOnOff':
                return {action: `${msg.endpoint.ID}_level_move_${msg.data.movemode ? 'down' : 'up'}`};
            case 'commandStopWithOnOff':
                return {action: `${msg.endpoint.ID}_level_stop`};
            }
        },
    },
    ubisys_c4_cover: {
        cluster: 'closuresWindowCovering',
        type: ['commandUpOpen', 'commandDownClose', 'commandStop'],
        convert: (model, msg, publish, options, meta) => {
            const lookup = {
                'commandUpOpen': 'open',
                'commandDownClose': 'close',
                'commandStop': 'stop',
            };
            return {action: `${msg.endpoint.ID}_cover_${lookup[msg.type]}`};
        },
    },
    EMIZB_132_power: {
        cluster: 'haElectricalMeasurement',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            // Cannot use electrical_measurement_power here as the reported divisor is not correct
            // https://github.com/Koenkk/zigbee-herdsman-converters/issues/974#issuecomment-600834722
            const payload = {};
            if (msg.data.hasOwnProperty('rmsCurrent')) {
                payload.current = precisionRound(msg.data['rmsCurrent'] / 10, 2);
            }
            if (msg.data.hasOwnProperty('rmsVoltage')) {
                payload.voltage = precisionRound(msg.data['rmsVoltage'] / 10, 2);
            }
            return payload;
        },
    },
    ZMCSW032D_cover_position_tilt: {
        cluster: 'closuresWindowCovering',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            const timeCoverSetMiddle = 60;

            // https://github.com/Koenkk/zigbee-herdsman-converters/pull/1336
            // Need to add time_close and time_open in your configuration.yaml after friendly_name (and set your time)
            if (options.hasOwnProperty('time_close') && options.hasOwnProperty('time_open')) {
                const deviceID = msg.device.ieeeAddr;
                if (!store[deviceID]) {
                    store[deviceID] = {lastPreviousAction: -1, CurrentPosition: -1, since: false};
                }
                // ignore if first action is middle and ignore action middle if previous action is middle
                if (msg.data.hasOwnProperty('currentPositionLiftPercentage') &&
                    msg.data['currentPositionLiftPercentage'] == 50 ) {
                    if ((store[deviceID].CurrentPosition == -1 && store[deviceID].lastPreviousAction == -1) ||
                        store[deviceID].lastPreviousAction == 50 ) {
                        console.log(`ZMCSW032D ignore action `);
                        return;
                    }
                }
                let currentPosition = store[deviceID].CurrentPosition;
                const lastPreviousAction = store[deviceID].lastPreviousAction;
                const deltaTimeSec = Math.floor((Date.now() - store[deviceID].since)/1000); // convert to sec

                store[deviceID].since = Date.now();
                store[deviceID].lastPreviousAction = msg.data['currentPositionLiftPercentage'];

                if (msg.data.hasOwnProperty('currentPositionLiftPercentage') &&
                    msg.data['currentPositionLiftPercentage'] == 50 ) {
                    if (deltaTimeSec < timeCoverSetMiddle || deltaTimeSec > timeCoverSetMiddle) {
                        if (lastPreviousAction == 100 ) {
                            // Open
                            currentPosition = currentPosition == -1 ? 0 : currentPosition;
                            currentPosition = currentPosition + ((deltaTimeSec * 100)/options.time_open);
                        } else if (lastPreviousAction == 0 ) {
                            // Close
                            currentPosition = currentPosition == -1 ? 100 : currentPosition;
                            currentPosition = currentPosition - ((deltaTimeSec * 100)/options.time_close);
                        }
                        currentPosition = currentPosition > 100 ? 100 : currentPosition;
                        currentPosition = currentPosition < 0 ? 0 : currentPosition;
                    }
                }
                store[deviceID].CurrentPosition = currentPosition;

                if (msg.data.hasOwnProperty('currentPositionLiftPercentage') &&
                    msg.data['currentPositionLiftPercentage'] !== 50 ) {
                    // postion cast float to int
                    result.position = currentPosition | 0;
                    result.position = options.invert_cover ? 100 - result.position : result.position;
                } else {
                    if (deltaTimeSec < timeCoverSetMiddle || deltaTimeSec > timeCoverSetMiddle) {
                        // postion cast float to int
                        result.position = currentPosition | 0;
                        result.position = options.invert_cover ? 100 - result.position : result.position;
                    } else {
                        store[deviceID].CurrentPosition = lastPreviousAction;
                        result.position = lastPreviousAction;
                        result.position = options.invert_cover ? 100 - result.position : result.position;
                    }
                }
            } else {
                // Previous solution without time_close and time_open
                if (msg.data.hasOwnProperty('currentPositionLiftPercentage') &&
                    msg.data['currentPositionLiftPercentage'] !== 50) {
                    const liftPercentage = msg.data['currentPositionLiftPercentage'];
                    result.position = liftPercentage;
                    result.position = options.invert_cover ? 100 - result.position : result.position;
                }
            }
            return result;
        },
    },
    SAGE206612_state: {
        cluster: 'genOnOff',
        type: 'commandOn',
        convert: (model, msg, publish, options, meta) => {
            const deviceId = msg.endpoint.deviceIeeeAddress;
            const timeout = 28;

            if (!store[deviceId]) {
                store[deviceId] = [];
            }

            const timer = setTimeout(() => {
                store[deviceId].pop();
            }, timeout * 1000);

            if (store[deviceId].length === 0 || store[deviceId].length > 4) {
                store[deviceId].push(timer);
                return {action: 'on'};
            } else {
                if (timeout > 0) {
                    store[deviceId].push(timer);
                }

                return null;
            }
        },
    },
    hy_thermostat: {
        cluster: 'manuSpecificTuya',
        type: ['commandSetDataResponse', 'commandGetData'],
        convert: (model, msg, publish, options, meta) => {
            const dp = msg.data.dp;
            const value = tuyaGetDataValue(msg.data.datatype, msg.data.data);

            switch (dp) {
            case common.TuyaDataPoints.hyWorkdaySchedule1: // schedule for workdays [5,9,12,8,0,15,10,0,15]
                return {workdays: [
                    {hour: value[0], minute: value[1], temperature: value[2]},
                    {hour: value[3], minute: value[4], temperature: value[5]},
                    {hour: value[6], minute: value[7], temperature: value[8]},
                ], range: 'am'};
            case common.TuyaDataPoints.hyWorkdaySchedule2: // schedule for workdays [15,0,25,145,2,17,22,50,14]
                return {workdays: [
                    {hour: value[0], minute: value[1], temperature: value[2]},
                    {hour: value[3], minute: value[4], temperature: value[5]},
                    {hour: value[6], minute: value[7], temperature: value[8]},
                ], range: 'pm'};
            case common.TuyaDataPoints.hyHolidaySchedule1: // schedule for holidays [5,5,20,8,4,13,11,30,15]
                return {holidays: [
                    {hour: value[0], minute: value[1], temperature: value[2]},
                    {hour: value[3], minute: value[4], temperature: value[5]},
                    {hour: value[6], minute: value[7], temperature: value[8]},
                ], range: 'am'};
            case common.TuyaDataPoints.hyHolidaySchedule2: // schedule for holidays [13,30,15,17,0,15,22,0,15]
                return {holidays: [
                    {hour: value[0], minute: value[1], temperature: value[2]},
                    {hour: value[3], minute: value[4], temperature: value[5]},
                    {hour: value[6], minute: value[7], temperature: value[8]},
                ], range: 'pm'};
            case common.TuyaDataPoints.hyHeating: // heating
                return {heating: value ? 'ON' : 'OFF'};
            case common.TuyaDataPoints.hyMaxTempProtection: // max temperature protection
                return {max_temperature_protection: value ? 'ON' : 'OFF'};
            case common.TuyaDataPoints.hyMinTempProtection: // min temperature protection
                return {min_temperature_protection: value ? 'ON' : 'OFF'};
            case common.TuyaDataPoints.hyState: // 0x017D work state
                return {state: value ? 'ON' : 'OFF'};
            case common.TuyaDataPoints.hyChildLock: // 0x0181 Changed child lock status
                return {child_lock: value ? 'LOCKED' : 'UNLOCKED'};
            case common.TuyaDataPoints.hyExternalTemp: // external sensor temperature
                return {external_temperature: (value / 10).toFixed(1)};
            case common.TuyaDataPoints.hyAwayDays: // away preset days
                return {away_preset_days: value};
            case common.TuyaDataPoints.hyAwayTemp: // away preset temperature
                return {away_preset_temperature: value};
            case common.TuyaDataPoints.hyTempCalibration: // 0x026D Temperature correction
                return {local_temperature_calibration: (value / 10).toFixed(1)};
            case common.TuyaDataPoints.hyHysteresis: // 0x026E Temperature hysteresis
                return {hysteresis: (value / 10).toFixed(1)};
            case common.TuyaDataPoints.hyProtectionHysteresis: // 0x026F Temperature protection hysteresis
                return {hysteresis_for_protection: value};
            case common.TuyaDataPoints.hyProtectionMaxTemp: // 0x027A max temperature for protection
                return {max_temperature_for_protection: value};
            case common.TuyaDataPoints.hyProtectionMinTemp: // 0x027B min temperature for protection
                return {min_temperature_for_protection: value};
            case common.TuyaDataPoints.hyMaxTemp: // 0x027C max temperature limit
                return {max_temperature: value};
            case common.TuyaDataPoints.hyMinTemp: // 0x027D min temperature limit
                return {min_temperature: value};
            case common.TuyaDataPoints.hyHeatingSetpoint: // 0x027E Changed target temperature
                return {current_heating_setpoint: (value / 10).toFixed(1)};
            case common.TuyaDataPoints.hyLocalTemp: // 0x027F MCU reporting room temperature
                return {local_temperature: (value / 10).toFixed(1)};
            case common.TuyaDataPoints.hySensor: // Sensor type
                return {sensor_type: {0: 'internal', 1: 'external', 2: 'both'}[value]};
            case common.TuyaDataPoints.hyPowerOnBehavior: // 0x0475 State after power on
                return {power_on_behavior: {0: 'restore', 1: 'off', 2: 'on'}[value]};
            case common.TuyaDataPoints.hyWeekFormat: // 0x0476 Week select 0 - 5 days, 1 - 6 days, 2 - 7 days
                return {week: common.TuyaThermostatWeekFormat[value]};
            case common.TuyaDataPoints.hyMode: // 0x0480 mode
                return {system_mode: {0: 'manual', 1: 'auto', 2: 'away'}[value]};
            case common.TuyaDataPoints.hyAlarm: // [16] [0]
                return {alarm: (value > 0) ? true : false};
            default: // The purpose of the codes 17 & 19 are still unknown
                console.log(`zigbee-herdsman-converters:hy_thermostat: NOT RECOGNIZED DP #${
                    dp} with data ${JSON.stringify(msg.data)}`);
            }
        },
    },

    // Ignore converters (these message dont need parsing).
    ignore_onoff_report: {
        cluster: 'genOnOff',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => null,
    },
    ignore_basic_report: {
        cluster: 'genBasic',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => null,
    },
    ignore_illuminance_report: {
        cluster: 'msIlluminanceMeasurement',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => null,
    },
    ignore_occupancy_report: {
        cluster: 'msOccupancySensing',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => null,
    },
    ignore_temperature_report: {
        cluster: 'msTemperatureMeasurement',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => null,
    },
    ignore_humidity_report: {
        cluster: 'msRelativeHumidity',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => null,
    },
    ignore_pressure_report: {
        cluster: 'msPressureMeasurement',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => null,
    },
    ignore_analog_report: {
        cluster: 'genAnalogInput',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => null,
    },
    ignore_multistate_report: {
        cluster: 'genMultistateInput',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => null,
    },
    ignore_power_report: {
        cluster: 'genPowerCfg',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => null,
    },
    ignore_light_brightness_report: {
        cluster: 'genLevelCtrl',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => null,
    },
    ignore_light_color_colortemp_report: {
        cluster: 'lightingColorCtrl',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => null,
    },
    ignore_closuresWindowCovering_report: {
        cluster: 'closuresWindowCovering',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => null,
    },
    ignore_thermostat_report: {
        cluster: 'hvacThermostat',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => null,
    },
    ignore_iaszone_attreport: {
        cluster: 'ssIasZone',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => null,
    },
    ignore_iaszone_statuschange: {
        cluster: 'ssIasZone',
        type: 'commandStatusChangeNotification',
        convert: (model, msg, publish, options, meta) => null,
    },
    ignore_iaszone_report: {
        cluster: 'ssIasZone',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => null,
    },
    ignore_genIdentify: {
        cluster: 'genIdentify',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => null,
    },
    _324131092621_ignore_on: {
        cluster: 'genOnOff',
        type: 'commandOn',
        convert: (model, msg, publish, options, meta) => null,
    },
    _324131092621_ignore_off: {
        cluster: 'genOnOff',
        type: 'commandOffWithEffect',
        convert: (model, msg, publish, options, meta) => null,
    },
    _324131092621_ignore_step: {
        cluster: 'genLevelCtrl',
        type: 'commandStep',
        convert: (model, msg, publish, options, meta) => null,
    },
    _324131092621_ignore_stop: {
        cluster: 'genLevelCtrl',
        type: 'commandStop',
        convert: (model, msg, publish, options, meta) => null,
    },
    ignore_poll_ctrl: {
        cluster: 'genPollCtrl',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => null,
    },
    ignore_genLevelCtrl_report: {
        cluster: 'genLevelCtrl',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => null,
    },
    ignore_genOta: {
        cluster: 'genOta',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => null,
    },
    ignore_haDiagnostic: {
        cluster: 'haDiagnostic',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => null,
    },
    ignore_zclversion_read: {
        cluster: 'genBasic',
        type: 'read',
        convert: (model, msg, publish, options, meta) => null,
    },
    ignore_time_read: {
        cluster: 'genTime',
        type: 'read',
        convert: (model, msg, publish, options, meta) => null,
    },
    tuya_ignore_set_time_request: {
        cluster: 'manuSpecificTuya',
        type: ['commandSetTimeRequest'],
        convert: (model, msg, publish, options, meta) => null,
    },
};

module.exports = converters;
