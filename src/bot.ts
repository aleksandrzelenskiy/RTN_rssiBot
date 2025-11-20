import { Telegraf, Markup } from 'telegraf';
import * as dotenv from 'dotenv';

dotenv.config();

const token = process.env.BOT_TOKEN;
if (!token) {
    throw new Error('BOT_TOKEN не задан в .env');
}

const bot = new Telegraf(token);

// 🔹 ID/username канала или группы
// Можно использовать '@cellular_installers', если это публичный канал/группа.
// Для надёжности лучше подставить numeric chat_id, если знаешь.
const CHANNEL_ID = '@cellular_installers';

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

const calib9xx: CalibPoint[] = [
    { voltage: 0.10, rsl: -90 },
    { voltage: 0.41, rsl: -85 },
    { voltage: 0.73, rsl: -80 },
    { voltage: 1.04, rsl: -75 },
    { voltage: 1.36, rsl: -70 },
    { voltage: 1.67, rsl: -65 },
    { voltage: 1.99, rsl: -60 },
    { voltage: 2.30, rsl: -55 },
    { voltage: 2.61, rsl: -50 },
    { voltage: 2.93, rsl: -45 },
    { voltage: 3.24, rsl: -40 },
    { voltage: 3.56, rsl: -35 },
    { voltage: 3.87, rsl: -30 },
    { voltage: 4.19, rsl: -25 },
    { voltage: 4.50, rsl: -20 },
];

const calib380: CalibPoint[] = [
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

// Кнопка «Подписаться»
function getSubscribeKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.url('🔔 Подписаться на канал', 'https://t.me/cellular_installers')],
    ]);
}

// Быстрая проверка: является ли пользователь участником
async function isSubscribed(ctx: any): Promise<boolean> {
    if (!ctx.from) return false;

    try {
        const member = await ctx.telegram.getChatMember(CHANNEL_ID, ctx.from.id);
        const status = member.status; // 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked'
        return status === 'creator' || status === 'administrator' || status === 'member';
    } catch (e) {
        console.error('getChatMember error:', e);
        // Если бот не может проверить (например, не в канале) – считаем, что не подписан
        return false;
    }
}

bot.start(async (ctx) => {
    const mode = getUserMode(ctx.from.id);

    await ctx.reply(
        `Привет! Я бот Huawei RSSI → RSL.\n` +
        `Текущий режим: <b>${mode}</b>.\n\n` +
        `Чтобы пользоваться ботом, подпишитесь на канал @cellular_installers.\n` +
        `После подписки просто снова отправьте /start.\n\n` +
        `Введите напряжение RSSI (в Вольтах), например: 2.8`,
        {
            parse_mode: 'HTML',
            ...getKeyboard(),
        } as any,
    );

    // Отдельным сообщением — кнопка подписки
    await ctx.reply(
        'Для доступа ко всем функциям подпишитесь на канал:',
        getSubscribeKeyboard(),
    );
});

bot.help(async (ctx) => {
    await ctx.reply(
        `<b>Инструкция:</b>\n\n` +
        `1. Подключите мультиметр к BNC-разъему RSSI на ODU Huawei.\n` +
        `2. Измерьте напряжение в Вольтах (обычно 0.8–4.5 В).\n` +
        `3. Отправьте это значение сюда — я переведу его в RSL (в dBm).\n\n` +
        `Выберите серию оборудования:\n` +
        `• RTN9xx (ODU XMC): типовая таблица Huawei.\n` +
        `• RTN380 (E-band): 0.84В = –78 dBm, 4.2В = –21 dBm.\n\n` +
        `Для пользовательской калибровки отправьте:\n` +
        `<code>custom v1 rsl1 v2 rsl2 [...vN rslN]</code>\n` +
        `Например:\n` +
        `<code>custom 0.5 -80 4.5 -20</code>\n\n` +
        `Для доступа ко всем функциям подпишитесь на канал @cellular_installers.`,
        {
            parse_mode: 'HTML',
            ...getKeyboard(),
        } as any,
    );

    await ctx.reply(
        'Кнопка для подписки на канал:',
        getSubscribeKeyboard(),
    );
});

// Middleware проверки подписки
bot.use(async (ctx, next) => {
    // Системные апдейты (callback_query, inline_query и т.п.) можно пропускать как есть
    if (!ctx.from) {
        return next();
    }

    // Забираем текст, если это message с текстом
    const text = (ctx.message as any)?.text as string | undefined;

    // /start и /help всегда доступны
    if (text && (text.startsWith('/start') || text.startsWith('/help'))) {
        return next();
    }

    const subscribed = await isSubscribed(ctx);
    if (!subscribed) {
        await ctx.reply(
            '🚫 Чтобы пользоваться ботом, подпишитесь на канал @cellular_installers, а затем повторите попытку.',
            getSubscribeKeyboard(),
        );
        return;
    }

    return next();
});

bot.hears([Mode.RTN9xx, Mode.RTN380, Mode.Custom], (ctx) => {
    const selected = ctx.message.text as Mode;
    setUserMode(ctx.from.id, selected);

    let hint = 'Отправьте напряжение RSSI (в Вольтах), например: 2.8';
    if (selected === Mode.Custom) {
        hint = `Отправьте свою калибровку:\n` +
            `custom v1 rsl1 v2 rsl2 [...vN rslN]\n` +
            `Например: custom 0.5 -80 4.5 -20`;
    }

    ctx.reply(
        `Режим переключён на: <b>${selected}</b>\n\n${hint}`,
        {
            parse_mode: 'HTML',
            ...getKeyboard(),
        } as any,
    );
});

bot.on('text', (ctx) => {
    const raw = ctx.message.text.trim();
    const input = raw.replace(',', '.');
    const userId = ctx.from.id;

    // Пользовательская калибровка
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

    // Обычное напряжение
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
        case Mode.Custom: {
            const points = userCustomCalib.get(userId);
            if (!points || points.length < 2) {
                ctx.reply('⚠️ Пользовательская калибровка не задана. Используйте команду custom ...');
                return;
            }
            rsl = interpolate(voltage, points);
            break;
        }
        default:
            rsl = NaN;
    }

    ctx.reply(
        `📡 Режим: ${mode}\n` +
        `U_RSSI = ${voltage.toFixed(2)} В\n` +
        `RSL ≈ ${rsl.toFixed(1)} dBm`,
    );
});

bot.launch().then(() => console.log('✅ RSSI Bot started'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
