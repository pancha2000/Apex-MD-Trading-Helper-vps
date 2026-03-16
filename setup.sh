#!/bin/bash

echo "🚀 APEX-MD Bot & AI Auto-Setup ආරම්භ වෙනවා..."

echo "📦 Node.js Packages ඉන්ස්ටෝල් වෙමින් පවතී..."
npm install

echo "🐍 Python AI පරිසරය සකසමින් පවතී..."
sudo apt update -y
sudo apt install python3-venv python3-pip -y
python3 -m venv ai_model/venv
source ai_model/venv/bin/activate
pip install fastapi uvicorn scikit-learn pandas numpy joblib

echo "🔄 පරණ බොට්ස් රන් වෙනවා නම් ඒවා නවත්වමින් පවතී..."
pm2 delete ApexAI ApexBot 2>/dev/null

echo "🤖 AI සර්වර් එක සහ බොට්ව PM2 හරහා ස්ටාර්ට් කරමින් පවතී..."
pm2 start ./ai_model/venv/bin/python --name "ApexAI" --cwd ./ai_model -- -m uvicorn app:app --host 0.0.0.0 --port 5000
pm2 start index.js --name "ApexBot"
pm2 save

echo "✅ සුපිරියි! සියලුම දේවල් සාර්ථකව ඉන්ස්ටෝල් වී ස්ටාර්ට් විය."
pm2 list
