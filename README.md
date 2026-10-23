# attendance-escrow — 출석 보증금 에스크로

블록체인기술과응용 팀과제. 스터디 출석 보증금을 스마트컨트랙트 에스크로로 운영한다.

- 체인: Sepolia 테스트넷 / 컨트랙트: Hardhat 2 + Solidity 0.8.24 / 프론트: HTML + ethers.js / 호스팅: AWS S3 정적 웹(플랜 B GitHub Pages)
- 구상안: `팀과제_에스크로_개발구상안_v0.2_20261022.pdf` (OneDrive 학교 폴더)
- 필수 기능 7: 생성, 예치, 회차 열기, 증빙 해시 제출, 상호 확인, 정산, 만료 반환(closeExpired)

## 폴더
| 폴더 | 내용 |
|---|---|
| contracts/ | AttendanceEscrow.sol |
| test/ | Hardhat 테스트 (목표 18개) |
| scripts/ | deploy.js |
| web/ | 정적 프론트 (S3 업로드 대상) |

## 실행
```
npm install
npm test                 # 로컬 Hardhat 네트워크에서 테스트
npm run compile
npm run deploy:sepolia   # .env 필요
npm run verify -- <주소> <생성자인자>
```

## 환경변수
`.env.example`을 복사해 `.env`를 만든다. `.env`는 git에 올라가지 않는다.