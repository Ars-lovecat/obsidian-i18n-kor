import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

/**
 * 여기에 정의된 배너는 생성된 파일의 최상단에 삽입됩니다.
 * 주로 저작권 정보, 버전 번호 또는 환경 선언을 추가하는 데 사용됩니다.
 */
const banner = ``;

/**
 * 명령줄 인수를 기반으로 현재 빌드가 운영 환경용인지 확인하십시오.
 * 명령 예시: node esbuild.config.mjs production
 */
const prod = (process.argv[2] === "production");

/**
 * esbuild 빌드 컨텍스트를 생성합니다.
 * context를 사용하면 빌드 매개변수를 설정하고, 
 * watch 모드나 rebuild 기능을 활성화할 수 있습니다.
 */
const context = await esbuild.context({
    // 생성된 JS 파일의 시작 부분에 코드를 삽입하세요.
    banner: {
        js: banner,
    },

    // 빌드 진입점의 경우, esbuild는 여기서부터 시작하여 
	// 모든 import 의존성을 재귀적으로 분석합니다.
    entryPoints: ["main.ts"],

    // 모든 의존성을 단일 파일로 묶을지 여부입니다. 
	// 이 설정은 반드시 `true`로 지정해야 합니다.
    bundle: true,

	// 외부 의존성 목록입니다. 이 모듈들은 main.js로 번들링되지 않으며,
	// 대신 런타임 환경에 이미 존재한다고 가정합니다. 
	// Obsidian 플러그인의 경우, 번들 크기가 과도하게 커지는 것을 방지하고
	// 에디터에 내장된 라이브러리를 활용하기 위해 obsidian, electron 및
	// 다양한 CodeMirror 구성 요소를 외부(external)로 지정해야 합니다.
    external: [
        "obsidian",
        "electron",
        "@codemirror/autocomplete",
        "@codemirror/collab",
        "@codemirror/commands",
        "@codemirror/language",
        "@codemirror/lint",
        "@codemirror/search",
        "@codemirror/state",
        "@codemirror/view",
        "@lezer/common",
        "@lezer/highlight",
        "@lezer/lr",
        ...builtins // Node.js 내장 모듈(path, fs 등)을 포함합니다.
    ],

    // 출력 코드 형식. 일반적으로 CommonJS('cjs') 형식을 사용합니다.
    format: "cjs",

    // 대상 환경을 설정하십시오. 
	// 출력 코드가 해당 버전의 JavaScript 엔진과 호환되도록 하십시오.
    target: "es2020",

    // 빌드 과정 중의 로그 상세 수준입니다. 
	// 'info'로 설정하면 빌드 소요 시간과 기본 상태 정보가 출력됩니다.
    logLevel: "info",

    // 코드 내에서 환경을 결정하기 위한 전역 변수를 정의하십시오.
    define: {
        "process.env.DEV_MODE": JSON.stringify(!prod),
    },

	/**
	* 소스 맵(Source Map) 설정:
	* 1. inline: 맵 정보가 main.js 파일 끝에 Base64 문자열로 포함됨 (권장X), 파일 크기가 매우 커짐.
	* 2. true: 별도의 main.js.map 파일을 생성함 (권장), 디버깅 편의성과 파일 크기 간의 균형을 고려함 
	* 3. false: 맵 정보를 생성하지 않음; 파일 크기는 가장 작지만 소스 수준의 디버깅은 불가능함. 
	*/
    sourcemap: true,

    // 참조되지 않는 코드(죽은 코드) 자동 제거
    treeShaking: true,

    // 코드를 최소화(minify). 공백과 줄바꿈을 제거, 변수 이름 난독화
    minify: true,

    // 프로덕션 환경에서 지정된 디버깅 문 제거
	// 예시) 모든 console.log 및 디버거를 제거
    drop: prod ? ["console", "debugger"] : [],

    // 법적 고지(특정 저작권 문구 등) 처리 방식 설정
	// none: 고지 모두 제거
    legalComments: "none",

    // 최종 생성된 결과물의 경로 및 파일명
    outfile: "main.js",
});

if (prod) {
    // 프로덕션 모드: 빌드 프로세스 1회 실행 후 종료
    await context.rebuild();
    process.exit(0);
} else {
    // 개발 모드: 감시(watch) 모드를 활성화 시, 
	// 소스코드 수정, 저장 시마다 esbuild가 자동으로 몇 초 만에 다시 빌드
    await context.watch();
}
