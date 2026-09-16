"""Vercel 서버리스 진입점.

Vercel 은 루트의 api/ 폴더에서 Python 함수를 찾는다.
기존 Flask 앱(backend/app)을 그대로 불러와서 WSGI 앱(app)으로 노출한다.
로컬 실행은 지금처럼 `python backend/run.py` 를 쓴다.
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

from app import create_app  # noqa: E402

# OPENAI_API_KEY 는 Vercel 프로젝트 설정 > Environment Variables 에 넣는다. (없으면 폴백 안내)
app = create_app()
