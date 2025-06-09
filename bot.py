import os
import logging
from dotenv import load_dotenv
import requests
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    ApplicationBuilder,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

load_dotenv()
TOKEN = os.getenv("TELEGRAM_TOKEN")
ADMIN_ID = os.getenv("ADMIN_ID")

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO
)
logger = logging.getLogger(__name__)


def get_weather() -> str:
    """Fetch simple weather information for Kyiv using open-meteo."""
    url = (
        "https://api.open-meteo.com/v1/forecast?latitude=50.45&longitude=30.52&current_weather=true"
    )
    try:
        r = requests.get(url, timeout=5)
        if r.status_code == 200:
            data = r.json()
            weather = data.get("current_weather", {})
            temp = weather.get("temperature")
            wind = weather.get("windspeed")
            return f"\u2600\ufe0f Температура: {temp} ℃, Вітер: {wind} км/год"
    except Exception as e:  # pylint: disable=broad-except
        logger.error("Weather error: %s", e)
    return "Не вдалося отримати погоду."


def get_rates() -> str:
    """Fetch currency rates from exchangerate.host."""
    url = "https://api.exchangerate.host/latest?base=USD"
    try:
        r = requests.get(url, timeout=5)
        if r.status_code == 200:
            data = r.json()
            uah = data.get("rates", {}).get("UAH")
            eur = data.get("rates", {}).get("EUR")
            return f"USD → UAH: {uah}\nUSD → EUR: {eur}"
    except Exception as e:  # pylint: disable=broad-except
        logger.error("Rate error: %s", e)
    return "Не вдалося отримати курс валют."


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Send main menu."""
    keyboard = [
        [InlineKeyboardButton("Яка сьогодні погода?", callback_data="weather")],
        [InlineKeyboardButton("Курс валют", callback_data="rates")],
    ]
    if ADMIN_ID and str(update.effective_user.id) == str(ADMIN_ID):
        keyboard.append([InlineKeyboardButton("Адмін панель", callback_data="admin")])
    await update.message.reply_text(
        "Вітаю! Оберіть опцію:", reply_markup=InlineKeyboardMarkup(keyboard)
    )


async def admin(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Admin command accessible only for ADMIN_ID."""
    if ADMIN_ID and str(update.effective_user.id) == str(ADMIN_ID):
        await update.message.reply_text("Адмін панель активна.")
    else:
        await update.message.reply_text("Нема доступу до адмін панелі.")


async def buttons(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle button presses."""
    query = update.callback_query
    await query.answer()
    data = query.data
    if data == "weather":
        await query.edit_message_text(get_weather())
    elif data == "rates":
        await query.edit_message_text(get_rates())
    elif data == "admin":
        await query.edit_message_text("Адмін панель. Використовуйте /admin")
    else:
        await query.edit_message_text("Невідома дія")


async def respond(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Reply to greetings and simple questions."""
    text = update.message.text.lower()
    if "привіт" in text or "hello" in text:
        reply = "Привіт! Чим можу допомогти?"
    elif text.endswith("?"):
        reply = (
            "На жаль, я ще не вмію відповідати на всі запитання, але "
            "працюю над цим."
        )
    else:
        reply = "Не зовсім зрозумів. Спробуйте використати /start."
    await update.message.reply_text(reply)


def main() -> None:
    """Run the bot."""
    if not TOKEN:
        raise RuntimeError("TELEGRAM_TOKEN not provided")
    application = ApplicationBuilder().token(TOKEN).build()

    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("admin", admin))
    application.add_handler(CallbackQueryHandler(buttons))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, respond))

    application.run_polling()


if __name__ == "__main__":
    main()
