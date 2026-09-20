import * as path from 'path';
import * as fs from 'fs-extra';
import './locales';     // i18n 설정 가져오기

import { App, Plugin, PluginManifest } from 'obsidian';
import { DEFAULT_SETTINGS, I18nSettings, LLMProfile } from './settings/data';
import { LLM_PROVIDERS } from './ai/constants';
import { I18nSettingTab } from './settings';
import { t } from './locales';

import { icons } from '~/utils';
import commands from './command';

import { APIManager, ViewManager, NoticeManager, StateManager, BackupManager, SourceManager, InjectorManager, CoreManager, ExtractManager, AutoManager } from './manager';
import { info } from './utils';
import { OBThemeManifest, Contributor, NameTranslationJSON } from '~/types';

import { LoggerManager } from './manager/logger';

import { EditorView, EDITOR_VIEW_TYPE } from './views/plugin_editor/editor';
import { ThemeEditorView, THEME_EDITOR_VIEW_TYPE } from './views/theme_editor/editor';
import { useGlobalStoreInstance } from './utils';
import { AgreementView, AGREEMENT_VIEW_TYPE } from './views/agreement';
import { ManagerView, MANAGER_VIEW_TYPE } from './views/manager/manager-view';
import { CloudView, CLOUD_VIEW_TYPE } from './views/cloud/cloud-view';
import { WizardView, WIZARD_VIEW_TYPE } from './views/wizard';

import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import { DevDebugCard } from './views/manager/dev-debug-card';

// ==============================
//          [입구] I18n
// ==============================
/**
 * Obsidian 다국어 번역 플러그인
 */
export default class I18N extends Plugin {
    settings: I18nSettings;     // [변수] 마스터 구성 파일
    css: string;
    sharedStyleSheet?: CSSStyleSheet; // [변수] 생성 후 여러 뷰가 공유하는 읽기 전용 CSSStyleSheet 객체.
    // [Core Manager] – 플러그인 기능 모듈 간 조정 허브
    notice: NoticeManager;      // [관리자] 알림 관리자
    logger: LoggerManager;      // [관리자] 로그 관리자
    view: ViewManager;          // [관리자] 뷰 관리자
    api: APIManager;            // [관리자] API 관리자
    stateManager: StateManager; // [관리자] 상태 관리자
    backupManager: BackupManager; // [관리자] 백업 관리자
    sourceManager: SourceManager; // [관리자] 번역 관리자
    injectorManager: InjectorManager; // [관리자] 주입 관리자
    coreManager: CoreManager; // [관리자] 핵심 관리자
    extractManager: ExtractManager; // [관리자] 추출 보조 관리자1
    autoManager: AutoManager; // [관리자] 자동화 관리
    activeSettingTab: string = 'basis'; // [변수] 현재 활성된 페이지

    private devRoot: ReactDOM.Root | null = null;


    // [변수] 플러그인 기여자 목록
    contributorCache: Contributor[] | undefined;

    // [변수][공유 클라우드] 번역할 텍스트 선택
    sharePath: string;
    shareType: number;
    shareObj: PluginManifest | OBThemeManifest;

    nameTranslationJSON: NameTranslationJSON;
    originalPluginsManifests: PluginManifest[];

    async onload() {
        info(this);                     // [load] 플러그인 정보
        icons();                        // [load] 아이콘
        commands(this.app, this);       // [load] 명령
        await this.loadSettings();      // [load] 구성

        if (process.env.DEV_MODE) {
            this.initDevDebug();
        }

        this.initManagers();            // [초기화] 관리자

        this.coreManager.getCss();      // [load] 스타일 클래스

        if (this.settings.agreement) {
            this.initViews();           // [초기화] 뷰
            this.initCores();           // [초기화] 핵심 기능
            this.coreManager.setupRibbonIcons();    // [초기화] 리본 아이콘

            useGlobalStoreInstance.getState().setI18n(this);
            this.addSettingTab(new I18nSettingTab(this.app, this));

            // [자동화] 예약된 검사 작업 등록 (설정된 값에 도달할 때까지 30분마다 확인)
            this.registerInterval(
                (window as any).setInterval(() => {
                    this.autoManager.checkAndRunDiscovery();
                }, 30 * 60 * 1000)
            );

            // 시작 중 증분 검사를 수행하기 위해 30초 지연 (프로세스 혼합 방지)
            setTimeout(() => {
                this.autoManager.checkAndRunDiscovery();
            }, 30 * 1000);
        } else {
            // 프로토콜 보기 등록 및 조회
            this.view.addView(AGREEMENT_VIEW_TYPE, (leaf) => new AgreementView(leaf, this), true);
            this.view.activateView(AGREEMENT_VIEW_TYPE);
        }
    }

    async onunload() {
        this.view.deactivateAllViews(); // 모든 뷰 삭제
        if (this.settings.modeImt) this.coreManager.deactivateIMT();  // 몰입형 번역 제거
        this.cleanupDevDebug();
    }

    // [설정] load
    public async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

        // 구 버전 디지털 ID 업그레이드 및 이전
        if (typeof this.settings.llmApi === 'number') {
            const legacyApiMap: Record<number, string> = {
                1: 'openai', 2: 'gemini', 3: 'ollama', 4: 'deepseek', 5: 'zhipu', 
                6: 'moonshot', 7: 'aliyun', 8: 'baidu', 9: 'bytedance', 10: 'groq', 
                11: 'siliconflow', 12: 'openrouter', 13: 'deepinfra', 14: 'mistral', 
                15: 'minimax', 16: 'stepfun'
            };
            this.settings.llmApi = legacyApiMap[this.settings.llmApi as number] || 'openai';
            await this.saveSettings();
        }

        await this.migrateLLMProfiles();
    }
    // [配置类] 保存
    public async saveSettings() { await this.saveData(this.settings); }

    /**
     * 모든 기존 서비스 제공업체 설정을 다중 프로필 구조로 통합하여 마이그레이션
     */
    private async migrateLLMProfiles() {
        let modified = false;

        Object.values(LLM_PROVIDERS).forEach(config => {
            const profilesField = `llm${config.labelKey}Profiles` as keyof I18nSettings;
            const activeIdField = `llm${config.labelKey}ActiveProfileId` as keyof I18nSettings;
            
            let profiles = this.settings[profilesField] as LLMProfile[];
            
            if (!profiles || profiles.length === 0) {
                const legacyUrlField = `llm${config.labelKey}Url` as keyof I18nSettings;
                const legacyKeyField = `llm${config.labelKey}Key` as keyof I18nSettings;
                const legacyModelField = `llm${config.labelKey}Model` as keyof I18nSettings;

                const defaultProfile: LLMProfile = {
                    id: 'default',
                    name: 'Default',
                    url: (this.settings[legacyUrlField] as string) || config.baseUrl || '',
                    key: (this.settings[legacyKeyField] as string) || '',
                    model: (this.settings[legacyModelField] as string) || config.defaultModel,
                    useCustomPrice: false,
                    priceInput: 0,
                    priceOutput: 0
                };
                
                (this.settings as any)[profilesField] = [defaultProfile];
                (this.settings as any)[activeIdField] = 'default';
                modified = true;
            } else {
                profiles.forEach(p => {
                    if (p.useCustomPrice === undefined) {
                        p.useCustomPrice = false;
                        p.priceInput = 0;
                        p.priceOutput = 0;
                        modified = true;
                    }
                });
            }

            // 데이터 중복을 방지하기 위해 기존 필드를 제거하고 마지막 반복 작업을 완료하세요.
			// (`settings` 객체에서 완전히 제거하려면 `as any`를 사용하세요).
            const legacyUrlField = `llm${config.labelKey}Url`;
            const legacyKeyField = `llm${config.labelKey}Key`;
            const legacyModelField = `llm${config.labelKey}Model`;
            if ((this.settings as any)[legacyUrlField] !== undefined) { delete (this.settings as any)[legacyUrlField]; modified = true; }
            if ((this.settings as any)[legacyKeyField] !== undefined) { delete (this.settings as any)[legacyKeyField]; modified = true; }
            if ((this.settings as any)[legacyModelField] !== undefined) { delete (this.settings as any)[legacyModelField]; modified = true; }
        });

        // 전역적으로 불필요한 사용자 정의 가격 필드 정리
        if ((this.settings as any).llmUseCustomPrice !== undefined) { delete (this.settings as any).llmUseCustomPrice; modified = true; }
        if ((this.settings as any).llmPriceInputCustom !== undefined) { delete (this.settings as any).llmPriceInputCustom; modified = true; }
        if ((this.settings as any).llmPriceOutputCustom !== undefined) { delete (this.settings as any).llmPriceOutputCustom; modified = true; }

        if (modified) await this.saveSettings();
    }


    /**
     * 핵심 관리자 초기화
     */
    private initManagers() {
        this.logger = LoggerManager.getInstance();
        this.notice = NoticeManager.getInstance(this);
        this.view = ViewManager.getInstance(this);
        this.api = APIManager.getInstance(this);
        this.stateManager = new StateManager(this);

        // @ts-ignore
        const i18nPluginDirBase = path.join(path.normalize(this.app.vault.adapter.getBasePath()), this.manifest.dir);
        this.backupManager = new BackupManager(i18nPluginDirBase);

        // [관리자] 번역 관리자
        // @ts-ignore
        const i18nPluginDir = path.join(path.normalize(this.app.vault.adapter.getBasePath()), this.manifest.dir);
        this.sourceManager = new SourceManager(i18nPluginDir);

        // [관리자] 사출 관리자
        this.injectorManager = new InjectorManager(this);

        // [관리자] 핵심 관리자
        this.coreManager = new CoreManager(this);

        // [관리자] 자동화 관리자
        this.autoManager = new AutoManager(this);

        // [관리자] 추출 보조 관리자 (일시적으로 숨기기)
        // this.extractManager = new ExtractManager(this);
    }

    /**
     * 플러그인용 사용자 지정 뷰를 등록하세요.
     */
    private initViews() {
        this.view.addView(EDITOR_VIEW_TYPE, (leaf) => new EditorView(leaf, this), true);
        this.view.addView(THEME_EDITOR_VIEW_TYPE, (leaf) => new ThemeEditorView(leaf, this), true);
        this.view.addView(CLOUD_VIEW_TYPE, (leaf) => new CloudView(leaf, this), true);
        this.view.addView(MANAGER_VIEW_TYPE, (leaf) => new ManagerView(leaf, this), true);
        this.view.addView(WIZARD_VIEW_TYPE, (leaf) => new WizardView(leaf, this), true);
    }

    private async initCores() {
        this.coreManager.firstRun();
        if (this.settings.checkUpdates) this.coreManager.checkUpdates();

        if (this.settings.automaticUpdate) await this.injectorManager.run(this.app);
        await this.autoManager.initialize();
        if (this.settings.autoDiscovery) await this.autoManager.runDiscovery();
        if (this.settings.modeImt) this.coreManager.activateIMT();

        // [청소] 제거된 플러그인의 중복 백업 및 상태 확인 후 정리합니다.
        await this.stateManager.cleanupRemovedResources(this.app);
    }

    public async onAgreementAccepted() {
        this.initViews();           // [초기화] 뷰
        await this.initCores();           // [초기화] 핵심 기능
        this.coreManager.setupRibbonIcons();    // [초기화] 리본 아이콘

        this.addSettingTab(new I18nSettingTab(this.app, this));
        // 초기화가 완료된 후 전역 I18N 인스턴스를 할당하십시오.
        useGlobalStoreInstance.getState().setI18n(this);

        this.view.deactivateView(AGREEMENT_VIEW_TYPE);
        this.view.activateView(WIZARD_VIEW_TYPE);
    }

    /** 공유 view load */
    public shareLoad(type: number, path: string, obj: PluginManifest | any) {
        this.shareType = type;
        this.sharePath = path;
        this.shareObj = obj;
    }

    private initDevDebug() {
        if (!process.env.DEV_MODE) return;
        const container = document.body.createDiv({ cls: 'i18n-dev-debug-container' });
        this.devRoot = ReactDOM.createRoot(container);
        this.devRoot.render(React.createElement(DevDebugCard, { i18n: this }));
    }

    private cleanupDevDebug() {
        if (this.devRoot) {
            this.devRoot.unmount();
            const container = document.body.querySelector('.i18n-dev-debug-container');
            if (container) container.remove();
            this.devRoot = null;
        }
    }
}
