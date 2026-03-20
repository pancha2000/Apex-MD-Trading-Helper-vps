#!/bin/bash

echo "🚀 APEX-MD Bot & AI Auto-Setup ආරම්භ වෙනවා..."

# ════════════════════════════════════════════════
# 📁 FOLDER STRUCTURE FIX (ZIP extract issues)
# ════════════════════════════════════════════════
echo ""
echo "📁 Folder structure fix කරමින් පවතී..."

PROJECT_DIR="$(pwd)"

# Fix 1: "web/public " (space) → "web/public"
if [ -d "$PROJECT_DIR/web/public " ]; then
    echo "   🔧 'web/public ' (space) fix කරමින්..."
    mkdir -p "$PROJECT_DIR/web/public/views/app"
    mkdir -p "$PROJECT_DIR/web/public/views/admin"
    mkdir -p "$PROJECT_DIR/web/public/views/auth"
    cp -r "$PROJECT_DIR/web/public /views/app/."    "$PROJECT_DIR/web/public/views/app/"
    cp -r "$PROJECT_DIR/web/public /views/admin/."  "$PROJECT_DIR/web/public/views/admin/"
    cp -r "$PROJECT_DIR/web/public /views/auth/."   "$PROJECT_DIR/web/public/views/auth/"
    rm -rf "$PROJECT_DIR/web/public "
fi

# Fix 2: CSS/ (uppercase) → css/ (lowercase)
mkdir -p "$PROJECT_DIR/web/public/css"
if [ -d "$PROJECT_DIR/web/public/CSS" ]; then
    cp "$PROJECT_DIR/web/public/CSS/"* "$PROJECT_DIR/web/public/css/"
    rm -rf "$PROJECT_DIR/web/public/CSS"
fi

# Fix 3: JS/ (uppercase) → js/ (lowercase)
mkdir -p "$PROJECT_DIR/web/public/js"
if [ -d "$PROJECT_DIR/web/public/JS" ]; then
    cp "$PROJECT_DIR/web/public/JS/"* "$PROJECT_DIR/web/public/js/"
    rm -rf "$PROJECT_DIR/web/public/JS"
fi

# Fix 4: Remove junk folders created by zip
[ -d "$PROJECT_DIR/web/{views" ] && rm -rf "$PROJECT_DIR/web/{views"

echo "   ✅ Folders හරිගස්සා!"

# ════════════════════════════════════════════════
# 📦 NODE.JS PACKAGES
# ════════════════════════════════════════════════
echo ""
echo "📦 Node.js Packages ඉන්ස්ටෝල් වෙමින් පවතී..."
npm install

# ════════════════════════════════════════════════
# 🐍 PYTHON AI
# ════════════════════════════════════════════════
echo ""
echo "🐍 Python AI පරිසරය සකසමින් පවතී..."
sudo apt update -y
sudo apt install python3-venv python3-pip -y
python3 -m venv ai_model/venv
source ai_model/venv/bin/activate
pip install fastapi uvicorn scikit-learn pandas numpy joblib

# ════════════════════════════════════════════════
# 🔄 PM2 RESTART
# ════════════════════════════════════════════════
echo ""
echo "🔄 පරණ බොට්ස් රන් වෙනවා නම් ඒවා නවත්වමින් පවතී..."
pm2 delete ApexAI ApexBot 2>/dev/null

echo ""
echo "🤖 AI සර්වර් එක සහ බොට්ව PM2 හරහා ස්ටාර්ට් කරමින් පවතී..."
pm2 start ./ai_model/venv/bin/python --name "ApexAI" --cwd ./ai_model -- -m uvicorn app:app --host 0.0.0.0 --port 5000
pm2 start index.js --name "ApexBot"
pm2 save

echo ""
echo "✅ සුපිරියි! සියලුම දේවල් සාර්ථකව ඉන්ස්ටෝල් වී ස්ටාර්ට් විය."
pm2 list
