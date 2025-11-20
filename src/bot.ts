import { Telegraf, Markup } from 'telegraf';
import * as dotenv from 'dotenv';

dotenv.config();

const token = process.env.BOT_TOKEN;
if (!token) {
    throw new Error('BOT_TOKEN не задан в .env');
}

const bot = new Telegraf(token);

enum Mode {
    RTN9xx = 'RTN9xx (XMC)',
    RTN380 = 'RTN380 (E-band)',
    Custom = 'Custom calibration',
}

interface CalibPoint {
    voltage: number;
    rsl: number;
}

const userModes = new Map<number, Mode>();
const userCustomCalib = new Map<number, CalibPoint[]>();

const calib9xx = [
    { voltage: 0.1, rsl: -90 },
    { voltage: 1.0, rsl: -76 },
    { voltage: 2.0, rsl: -60 },
    { voltage: 3.0, rsl: -45 },
    { voltage: 4.0, rsl: -30 },
    { voltage: 4.5, rsl: -20 },
];

const calib380 = [
    { voltage: 0.84, rsl: -78 },
    { voltage: 4.20, rsl: -21 },
];

function interpolate(voltage: number, points: CalibPoint[]): number {
    if (voltage <= points[0].voltage) return points[0].rsl;
    if (voltage >= points[points.length - 1].voltage) return points[points.length - 1].rsl;

    for (let i = 1; i < points.length; i++) {
        const lower = points[i - 1];
        const upper = points[i];
        if (voltage <= upper.voltage) {
            const ratio = (voltage - lower.voltage) / (upper.voltage - lower.voltage);
            return lower.rsl + ratio * (upper.rsl - lower.rsl);
        }
    }
    return NaN;
}

function getUserMode(userId: number): Mode {
    return userModes.get(userId) || Mode.RTN9xx;
}

function setUserMode(userId: number, mode: Mode) {
    userModes.set(userId, mode);
}

function getKeyboard() {
    return Markup.keyboard([[Mode.RTN9xx, Mode.RTN380], [Mode.Custom]]).resize();
}

bot.start((ctx) => {
    const mode = getUserMode(ctx.from.id);
    ctx.reply(
        `Привет! Я бот Huawei RSSI → RSL.\nТекущий режим: *${mode}*.\n\nВведите напряжение RSSI (в Вольтах), например: 2.8`,
        { parse_mode: 'Markdown', ...getKeyboard() }
    );
});

bot.help((ctx) => {
    ctx.reply(
        `*Инструкция:*\n\n1. Подключите мультиметр к BNC-разъему RSSI на ODU Huawei.\n2. Измерьте напряжение в Вольтах (обычно 0.8–4.5 В).\n3. Отправьте это значение сюда — я переведу его в RSL (в dBm).\n\nВыберите серию оборудования:\n• RTN9xx (ODU XMC): типовая таблица Huawei.\n• RTN380 (E-band): 0.84В = –78 dBm, 4.2В = –21 dBm.\n\nДля пользовательской калибровки отправьте:\ncustom v1 rsl1 v2 rsl2 [...vN rslN]\nНапример:\ncustom 0.5 -80 4.5 -20`,
        { parse_mode: 'Markdown', ...getKeyboard() }
    );
});

bot.hears([Mode.RTN9xx, Mode.RTN380, Mode.Custom], (ctx) => {
    const selected = ctx.message.text as Mode;
    setUserMode(ctx.from.id, selected);

    let hint = 'Отправьте напряжение RSSI (в Вольтах), например: 2.8';
    if (selected === Mode.Custom) {
        hint = `Отправьте свою калибровку:
custom v1 rsl1 v2 rsl2 [...vN rslN]
Например: custom 0.5 -80 4.5 -20`;
    }

    ctx.reply(`Режим переключён на: *${selected}*\n\n${hint}`, {
        parse_mode: 'Markdown',
        ...getKeyboard(),
    });
});

bot.on('text', (ctx) => {
    const raw = ctx.message.text.trim();
    const input = raw.replace(',', '.');
    const userId = ctx.from.id;

    if (raw.toLowerCase().startsWith('custom')) {
        const parts = input.split(/\s+/).slice(1);
        if (parts.length < 4 || parts.length % 2 !== 0) {
            ctx.reply('⚠️ Введите хотя бы две пары значений: custom v1 rsl1 v2 rsl2 ...');
            return;
        }
        const points: CalibPoint[] = [];
        for (let i = 0; i < parts.length; i += 2) {
            const voltage = parseFloat(parts[i]);
            const rsl = parseFloat(parts[i + 1]);
            if (isNaN(voltage) || isNaN(rsl)) {
                ctx.reply('⚠️ Ошибка в формате. Пример: custom 0.5 -80 4.5 -20');
                return;
            }
            points.push({ voltage, rsl });
        }
        points.sort((a, b) => a.voltage - b.voltage);
        userCustomCalib.set(userId, points);
        setUserMode(userId, Mode.Custom);
        ctx.reply('✅ Пользовательская калибровка сохранена и активирована.', getKeyboard());
        return;
    }

    if (!/^\d+(\.\d+)?$/.test(input)) return;

    const voltage = parseFloat(input);
    if (isNaN(voltage)) {
        ctx.reply('⚠️ Пожалуйста, введите число — напряжение в Вольтах.');
        return;
    }

    const mode = getUserMode(userId);
    let rsl: number;

    switch (mode) {
        case Mode.RTN9xx:
            rsl = interpolate(voltage, calib9xx);
            break;
        case Mode.RTN380:
            rsl = interpolate(voltage, calib380);
            break;
        case Mode.Custom:
            const points = userCustomCalib.get(userId);
            if (!points || points.length < 2) {
                ctx.reply('⚠️ Пользовательская калибровка не задана. Используйте команду custom ...');
                return;
            }
            rsl = interpolate(voltage, points);
            break;
    }

    ctx.reply(`📡 Режим: ${mode}\nU_RSSI = ${voltage.toFixed(2)} В\nRSL ≈ ${rsl.toFixed(1)} dBm`);
});

bot.launch().then(() => console.log('✅ RSSI Bot started'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));