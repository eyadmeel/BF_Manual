# BF Manual — AI 안전 경로 분석 기반 맞춤형 화재 대피 지원 서비스

## 폴더 구조

```
bf-manual/
├─ backend/
│  ├─ run.py                     # 진입점 
│  ├─ requirements.txt
│  ├─ .env.example               # OPENAI_API_KEY 
│  ├─ app/
│  │  ├─ __init__.py             # create_app() 앱 팩토리 + 프론트 서빙
│  │  ├─ api/
│  │  │  └─ routes.py            # REST 엔드포인트 전부
│  │  ├─ services/               # ★ 비즈니스 로직 
│  │  │  ├─ mobility.py          # 이동 가능 여부 프로파일 정의
│  │  │  ├─ graph_loader.py      # JSON 로딩 + 인접리스트 + 이벤트 적용
│  │  │  ├─ pathfinder.py        # 다익스트라 안전 경로 탐색 
│  │  │  ├─ guide_agent.py       # LangGraph/OpenAI 행동요령 + 폴백
│  │  │  └─ help_message.py      # 도움 요청 미리보기 텍스트
│  │  └─ data/                   
│  │     ├─ building.json        # 노드·엣지·시설 정보
│  │     └─ hazard_scenarios.json# 시연용 화재 시나리오 + 이벤트
│  └─ tests/
│     └─ test_pathfinder.py      # 상태별 목적지 분기 검증
├─ frontend/                     # HTML5/CSS3/JS 
│  ├─ index.html
│  ├─ css/
│  └─ js/
├─ docs/                         # 기획서, 평면도, 발표자료
└─ .gitignore
```

### 구조를 이렇게 잡은 이유

- **`api/`와 `services/`를 분리** — 경로 로직을 Flask 없이 단독 실행·테스트할 수 있습니다.
  `python tests/test_pathfinder.py` 한 줄로 검증되므로 서버를 안 띄우고도 작업 가능.
- **`data/`를 코드와 분리** — 평면도 매핑 담당자가 Python을 몰라도 JSON만 수정하면 됩니다.
  두 사람이 동시에 작업해도 충돌이 안 납니다.
- **`guide_agent.py`를 경로 엔진과 분리** — OpenAI가 죽어도 경로는 나옵니다.
  "AI가 틀리면?" 질문에 대한 구조적 답변이 됩니다.
- **프론트엔드를 Flask가 서빙** — 별도 서버·CORS 설정 없이 `localhost:5000` 하나로 시연합니다.


## API

| 메서드 | 경로                | 설명                                                    |
| ------ | ------------------- | ------------------------------------------------------- |
| GET    | `/api/health`       | 헬스체크                                                |
| GET    | `/api/building`     | 노드·엣지·시설 (평면도 렌더링용)                        |
| GET    | `/api/mobility`     | 이동 상태 선택지 4종                                    |
| GET    | `/api/scenarios`    | 시연 시나리오 + 이벤트 목록                             |
| POST   | `/api/route`        | `{mobility, start_node, scenario, events[]}` → 경로     |
| POST   | `/api/guide`        | `{route}` → 행동요령 (느림, 경로 표시 후 호출)          |
| POST   | `/api/reroute`      | `{mobility, current_node, scenario, events[]}` → 재탐색 |
| POST   | `/api/help-message` | `{route, note}` → 도움 요청 문구                        |
| POST   | `/api/dev/reload`   | JSON 수정 후 캐시 비우기                                |
