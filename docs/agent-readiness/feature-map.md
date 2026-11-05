# Hercules feature map (generated)

Do not hand-edit — run `pnpm feature-map` (or `node scripts/feature-map.mjs`).

| Metric | Count |
|--------|------:|
| Anchors (static) | 295 |
| Anchors (dynamic) | 13 |
| Scenes | 9 |
| Covered anchors | 21 |
| Unknown anchors | 0 |
| Unknown task ids | 0 |

## L2 scenes

### shell

- unlock
- screenshot shell

### settings

- click [data-evidence=nav-settings]
- assert selector [data-evidence=settings-panel]
- assert text Settings|设置|Language|语言|Logout|退出
- screenshot settings

### releases

- click [data-evidence=nav-releases]
- assert selector [data-evidence=releases-panel]
- assert selector [data-evidence=promote-btn]
- screenshot releases

### adapter-failover-timeline

- click [data-evidence=nav-tasks]
- click [data-task-id=l2-fixture-00-resilience-failover]
- assert selector [data-evidence=run-timeline]
- click [data-evidence=run-timeline-summary]
- assert selector [data-evidence=adapter-failover-timeline]
- assert text 降级
- screenshot adapter-failover-timeline

### agent-death-cause

- assert selector [data-evidence=agent-death-cause]
- assert text Death cause|xAI 502|mid-stream
- screenshot agent-death-cause

### m7-pass-evidence-learning

- click [data-evidence=task-detail-close]
- click [data-task-id=l2-m7-pass]
- click [data-evidence=review-mode-outcome]
- assert selector [data-evidence=outcome-review]
- click [data-evidence=open-review-evidence]
- assert selector [data-evidence=review-evidence-drawer]
- assert selector [data-evidence=learning-proposal]
- screenshot m7-pass-evidence-learning

### m7-verified-fail

- click [data-evidence=task-detail-close]
- click [data-task-id=l2-m7-fail]
- click [data-evidence=review-mode-outcome]
- assert selector [data-evidence=review-request-changes]
- screenshot m7-verified-fail

### m7-missing-evidence

- click [data-evidence=task-detail-close]
- click [data-task-id=l2-m7-missing]
- click [data-evidence=review-mode-outcome]
- assert selector [data-evidence=review-more-evidence]
- screenshot m7-missing-evidence

### m7-human-confirmation

- click [data-evidence=task-detail-close]
- click [data-task-id=l2-m7-human]
- click [data-evidence=review-mode-outcome]
- click [data-evidence=review-open-approve]
- assert selector [data-evidence=review-risk-acknowledgement]
- assert text Approval is not merge or deployment
- screenshot m7-human-confirmation

## Chrome by area

### adapter

| anchor | file(s) | covered |
|--------|---------|---------|
| `adapter-failover-timeline` | src/web/RunTimeline.tsx | ✅ |

### agent

| anchor | file(s) | covered |
|--------|---------|---------|
| `agent-death-cause` | src/web/RunTimeline.tsx | ✅ |
| `agent-report` | src/web/TaskDetail.tsx | ◻ |

### ahead

| anchor | file(s) | covered |
|--------|---------|---------|
| `ahead-task-*` | src/web/ReleasesPanel.tsx | ◻ |

### assistant

| anchor | file(s) | covered |
|--------|---------|---------|
| `assistant-live-steps` | src/web/VoiceControl.tsx | ◻ |
| `assistant-open-chat` | src/web/VoiceControl.tsx | ◻ |
| `assistant-perm-mode` | src/web/VoiceControl.tsx | ◻ |
| `assistant-reply-bubble` | src/web/AssistantReplyBubble.tsx | ◻ |
| `assistant-reply-chrome` | src/web/AssistantReplyBubble.tsx | ◻ |
| `assistant-settings` | src/web/VoiceControl.tsx | ◻ |
| `assistant-settings-toggle` | src/web/VoiceControl.tsx | ◻ |
| `assistant-text-log` | src/web/VoiceControl.tsx | ◻ |
| `assistant-text-panel` | src/web/VoiceControl.tsx | ◻ |

### blocked

| anchor | file(s) | covered |
|--------|---------|---------|
| `blocked-deps` | src/web/TaskDetail.tsx | ◻ |

### bottom

| anchor | file(s) | covered |
|--------|---------|---------|
| `bottom-nav` | src/web/App.tsx | ◻ |

### boundary

| anchor | file(s) | covered |
|--------|---------|---------|
| `boundary-badge-*` | src/web/TaskDetail.tsx | ◻ |
| `boundary-badge-detail` | src/web/TaskDetail.tsx | ◻ |

### chat

| anchor | file(s) | covered |
|--------|---------|---------|
| `chat-outcome` | src/web/TaskDetail.tsx | ◻ |
| `chat-queued` | src/web/TaskDetail.tsx | ◻ |

### cli

| anchor | file(s) | covered |
|--------|---------|---------|
| `cli-evidence-receipt` | src/web/taskBody.tsx, src/web/TaskDetail.tsx | ◻ |

### copy

| anchor | file(s) | covered |
|--------|---------|---------|
| `copy-staging-token` | src/web/ReleasesPanel.tsx | ◻ |

### create

| anchor | file(s) | covered |
|--------|---------|---------|
| `create-ac-lint` | src/web/CreateForm.tsx | ◻ |
| `create-analyst-activity` | src/web/CreateForm.tsx | ◻ |
| `create-analyst-expand` | src/web/CreateForm.tsx | ◻ |
| `create-analyst-notes` | src/web/CreateForm.tsx | ◻ |
| `create-draft-apply` | src/web/CreateForm.tsx | ◻ |
| `create-draft-source` | src/web/CreateForm.tsx | ◻ |
| `create-fill-onboarding` | src/web/CreateForm.tsx | ◻ |
| `create-fill-readiness-pipeline` | src/web/CreateForm.tsx | ◻ |
| `create-incomplete-repo` | src/web/CreateForm.tsx | ◻ |
| `create-intent-warn` | src/web/CreateForm.tsx | ◻ |
| `create-open` | src/web/App.tsx | ◻ |
| `create-repo` | src/web/CreateForm.tsx | ◻ |
| `create-slug-preview` | src/web/CreateForm.tsx | ◻ |
| `create-submit` | src/web/CreateForm.tsx | ◻ |
| `create-submitting` | src/web/CreateForm.tsx | ◻ |

### decide

| anchor | file(s) | covered |
|--------|---------|---------|
| `decide-why` | src/web/TaskDetail.tsx | ◻ |

### decision

| anchor | file(s) | covered |
|--------|---------|---------|
| `decision-card` | src/web/TaskDetail.tsx | ◻ |
| `decision-inbox` | src/web/App.tsx | ◻ |
| `decision-summary` | src/web/TaskDetail.tsx | ◻ |

### delivery

| anchor | file(s) | covered |
|--------|---------|---------|
| `delivery-pipeline` | src/web/ReleasesPanel.tsx | ◻ |

### dep

| anchor | file(s) | covered |
|--------|---------|---------|
| `dep-hold-*` | src/web/TaskDetail.tsx | ◻ |

### dependency

| anchor | file(s) | covered |
|--------|---------|---------|
| `dependency-rewire` | src/web/TaskDetail.tsx | ◻ |

### deploy

| anchor | file(s) | covered |
|--------|---------|---------|
| `deploy-staging-btn` | src/web/ReleasesPanel.tsx | ◻ |

### disk

| anchor | file(s) | covered |
|--------|---------|---------|
| `disk-warn` | src/web/App.tsx | ◻ |

### dispatch

| anchor | file(s) | covered |
|--------|---------|---------|
| `dispatch-hold` | src/web/App.tsx, src/web/TaskDetail.tsx | ◻ |

### evidence

| anchor | file(s) | covered |
|--------|---------|---------|
| `evidence-chip` | src/web/EvidenceGallery.tsx | ◻ |
| `evidence-chips` | src/web/EvidenceGallery.tsx | ◻ |
| `evidence-coverage` | src/web/ReleasesPanel.tsx | ◻ |
| `evidence-first` | src/web/EvidenceGallery.tsx | ◻ |
| `evidence-gallery` | src/web/EvidenceGallery.tsx | ◻ |
| `evidence-lightbox` | src/web/EvidenceGallery.tsx | ◻ |
| `evidence-shot` | src/web/EvidenceGallery.tsx | ◻ |
| `evidence-video` | src/web/EvidenceGallery.tsx | ◻ |

### failure

| anchor | file(s) | covered |
|--------|---------|---------|
| `failure-brief` | src/web/TaskDetail.tsx | ◻ |

### host

| anchor | file(s) | covered |
|--------|---------|---------|
| `host-op-approval` | src/web/TaskDetail.tsx | ◻ |
| `host-op-approve-btn` | src/web/TaskDetail.tsx | ◻ |
| `host-op-approved` | src/web/TaskDetail.tsx | ◻ |
| `host-op-scope-input` | src/web/TaskDetail.tsx | ◻ |

### human

| anchor | file(s) | covered |
|--------|---------|---------|
| `human-ac-action` | src/web/App.tsx, src/web/TaskDetail.tsx | ◻ |
| `human-ac-action-err` | src/web/TaskDetail.tsx | ◻ |
| `human-ac-after-deploy` | src/web/TaskDetail.tsx | ◻ |
| `human-ac-doc` | src/web/TaskDetail.tsx | ◻ |
| `human-ac-how` | src/web/TaskDetail.tsx | ◻ |
| `human-ac-ref` | src/web/App.tsx, src/web/TaskDetail.tsx | ◻ |
| `human-ac-unproven` | src/web/TaskDetail.tsx, src/web/TasksPanel.tsx | ◻ |

### intent

| anchor | file(s) | covered |
|--------|---------|---------|
| `intent-clarify` | src/web/CreateForm.tsx | ◻ |
| `intent-clarify-option` | src/web/CreateForm.tsx | ◻ |
| `intent-clarify-skip` | src/web/CreateForm.tsx | ◻ |
| `intent-filled` | src/web/CreateForm.tsx | ◻ |

### l3

| anchor | file(s) | covered |
|--------|---------|---------|
| `l3-report` | src/web/taskBody.tsx | ◻ |

### lane

| anchor | file(s) | covered |
|--------|---------|---------|
| `lane-deployment` | src/web/ReleasesPanel.tsx | ◻ |
| `lane-merge-eligibility` | src/web/ReleasesPanel.tsx, src/web/TaskDetail.tsx | ◻ |
| `lane-project-state-closure` | src/web/ReleasesPanel.tsx, src/web/TaskDetail.tsx | ◻ |
| `lane-verification` | src/web/ReleasesPanel.tsx, src/web/TaskDetail.tsx | ◻ |

### learning

| anchor | file(s) | covered |
|--------|---------|---------|
| `learning-proposal` | src/web/review/LearningProposalPanel.tsx | ✅ |

### legacy

| anchor | file(s) | covered |
|--------|---------|---------|
| `legacy-task-actions` | src/web/TaskDetail.tsx | ◻ |

### list

| anchor | file(s) | covered |
|--------|---------|---------|
| `list` | src/web/PullToRefresh.tsx | ◻ |

### live

| anchor | file(s) | covered |
|--------|---------|---------|
| `live-activity` | src/web/TaskDetail.tsx | ◻ |
| `live-activity-log` | src/web/TaskDetail.tsx | ◻ |
| `live-quick-actions` | src/web/TaskDetail.tsx | ◻ |
| `live-status-pill` | src/web/TaskDetail.tsx | ◻ |

### machine

| anchor | file(s) | covered |
|--------|---------|---------|
| `machine-details` | src/web/TaskDetail.tsx | ◻ |

### merge

| anchor | file(s) | covered |
|--------|---------|---------|
| `merge-blocked-deps` | src/web/TaskDetail.tsx | ◻ |
| `merge-btn` | src/web/ReleasesPanel.tsx | ◻ |
| `merge-gate-failure-receipt` | src/web/mergeGateFailureBanner.tsx | ◻ |
| `merge-gate-failure-summary` | src/web/mergeGateFailureBanner.tsx | ◻ |
| `merge-gate-next-action` | src/web/mergeGateFailureBanner.tsx | ◻ |
| `merge-operation-status` | src/web/ReleasesPanel.tsx | ◻ |
| `merge-task-*` | src/web/ReleasesPanel.tsx | ◻ |

### nav

| anchor | file(s) | covered |
|--------|---------|---------|
| `nav-chat` | src/web/App.tsx | ◻ |
| `nav-releases` | src/web/App.tsx | ✅ |
| `nav-repos` | src/web/App.tsx | ◻ |
| `nav-settings` | src/web/App.tsx | ✅ |
| `nav-tasks` | src/web/App.tsx | ✅ |

### open

| anchor | file(s) | covered |
|--------|---------|---------|
| `open-review-evidence` | src/web/review/AcceptanceMatrix.tsx | ✅ |

### operator

| anchor | file(s) | covered |
|--------|---------|---------|
| `operator-merged-*` | src/web/ReleasesPanel.tsx | ◻ |
| `operator-notice` | src/web/App.tsx | ◻ |

### outcome

| anchor | file(s) | covered |
|--------|---------|---------|
| `outcome-review` | src/web/review/OutcomeReviewPanel.tsx | ✅ |

### override

| anchor | file(s) | covered |
|--------|---------|---------|
| `override-approve` | src/web/TaskDetail.tsx | ◻ |

### packet

| anchor | file(s) | covered |
|--------|---------|---------|
| `packet-details` | src/web/TaskDetail.tsx | ◻ |

### pr

| anchor | file(s) | covered |
|--------|---------|---------|
| `pr-thrash` | src/web/TaskDetail.tsx | ◻ |

### prior

| anchor | file(s) | covered |
|--------|---------|---------|
| `prior-run-failures` | src/web/taskBody.tsx | ◻ |

### promote

| anchor | file(s) | covered |
|--------|---------|---------|
| `promote-btn` | src/web/ReleasesPanel.tsx | ✅ |

### promoting

| anchor | file(s) | covered |
|--------|---------|---------|
| `promoting-pill` | src/web/ReleasesPanel.tsx | ◻ |

### pull

| anchor | file(s) | covered |
|--------|---------|---------|
| `pull-indicator` | src/web/PullToRefresh.tsx | ◻ |
| `pull-to-refresh` | src/web/PullToRefresh.tsx | ◻ |

### queue

| anchor | file(s) | covered |
|--------|---------|---------|
| `queue-front` | src/web/QueueFrontButton.tsx | ◻ |

### release

| anchor | file(s) | covered |
|--------|---------|---------|
| `release-packet` | src/web/ReleasesPanel.tsx | ◻ |
| `release-repo-*` | src/web/ReleasesPanel.tsx | ◻ |
| `release-shot-*` | src/web/EvidenceGallery.tsx | ◻ |
| `release-shot-lightbox` | src/web/EvidenceGallery.tsx | ◻ |

### releases

| anchor | file(s) | covered |
|--------|---------|---------|
| `releases-after-deploy` | src/web/ReleasesPanel.tsx | ◻ |
| `releases-digest` | src/web/ReleasesPanel.tsx | ◻ |
| `releases-direct-commits` | src/web/ReleasesPanel.tsx | ◻ |
| `releases-drift` | src/web/ReleasesPanel.tsx | ◻ |
| `releases-empty` | src/web/ReleasesPanel.tsx | ◻ |
| `releases-evidence` | src/web/ReleasesPanel.tsx | ◻ |
| `releases-failure` | src/web/ReleasesPanel.tsx | ◻ |
| `releases-flash` | src/web/ReleasesPanel.tsx | ◻ |
| `releases-load-error` | src/web/ReleasesPanel.tsx | ◻ |
| `releases-merge` | src/web/ReleasesPanel.tsx | ◻ |
| `releases-panel` | src/web/ReleasesPanel.tsx | ✅ |
| `releases-risk` | src/web/ReleasesPanel.tsx | ◻ |
| `releases-rollback-preview` | src/web/ReleasesPanel.tsx | ◻ |
| `releases-screenshots` | src/web/ReleasesPanel.tsx | ◻ |
| `releases-sensitive` | src/web/ReleasesPanel.tsx | ◻ |
| `releases-shell-actions` | src/web/ReleasesPanel.tsx | ◻ |
| `releases-soak` | src/web/ReleasesPanel.tsx | ◻ |
| `releases-trust-chain` | src/web/ReleasesPanel.tsx | ◻ |

### repo

| anchor | file(s) | covered |
|--------|---------|---------|
| `repo-*` | src/web/ReposPanel.tsx | ◻ |
| `repo-add-execution-policy` | src/web/ReposPanel.tsx | ◻ |
| `repo-auto-merge-badge` | src/web/ReposPanel.tsx | ◻ |
| `repo-auto-merge-dwell` | src/web/ReposPanel.tsx | ◻ |
| `repo-auto-merge-enabled` | src/web/ReposPanel.tsx | ◻ |
| `repo-auto-merge-max-size` | src/web/ReposPanel.tsx | ◻ |
| `repo-browse-docs` | src/web/ReposPanel.tsx | ◻ |
| `repo-check-*` | src/web/ReposPanel.tsx | ◻ |
| `repo-check-readiness` | src/web/ReposPanel.tsx | ◻ |
| `repo-doc-row` | src/web/ReposPanel.tsx | ◻ |
| `repo-doc-view` | src/web/ReposPanel.tsx | ◻ |
| `repo-docs` | src/web/ReposPanel.tsx | ◻ |
| `repo-docs-all-toggle` | src/web/ReposPanel.tsx | ◻ |
| `repo-docs-entrypoints` | src/web/ReposPanel.tsx | ◻ |
| `repo-docs-search` | src/web/ReposPanel.tsx | ◻ |
| `repo-execution-policy-select` | src/web/ReposPanel.tsx | ◻ |
| `repo-filter` | src/web/TasksPanel.tsx | ◻ |
| `repo-filter-all` | src/web/TasksPanel.tsx | ◻ |
| `repo-filter-chip` | src/web/TasksPanel.tsx | ◻ |
| `repo-filter-empty` | src/web/TasksPanel.tsx | ◻ |
| `repo-flash` | src/web/ReposPanel.tsx | ◻ |
| `repo-guardian-readiness` | src/web/ReposPanel.tsx | ◻ |
| `repo-guardian-remediation` | src/web/ReposPanel.tsx | ◻ |
| `repo-mark-ready` | src/web/ReposPanel.tsx | ◻ |
| `repo-mark-ready-force` | src/web/ReposPanel.tsx | ◻ |
| `repo-onboarding-active` | src/web/ReposPanel.tsx | ◻ |
| `repo-onboarding-failed` | src/web/ReposPanel.tsx | ◻ |
| `repo-open-onboarding` | src/web/ReposPanel.tsx | ◻ |
| `repo-readiness` | src/web/ReposPanel.tsx | ◻ |
| `repo-readiness-detail` | src/web/ReposPanel.tsx | ◻ |
| `repo-readiness-score` | src/web/ReposPanel.tsx | ◻ |
| `repo-readiness-select` | src/web/ReposPanel.tsx | ◻ |
| `repo-readiness-status` | src/web/ReposPanel.tsx | ◻ |
| `repo-reprobe-readiness` | src/web/ReposPanel.tsx | ◻ |
| `repo-start-onboarding` | src/web/ReposPanel.tsx | ◻ |

### repos

| anchor | file(s) | covered |
|--------|---------|---------|
| `repos-empty` | src/web/ReposPanel.tsx | ◻ |
| `repos-panel` | src/web/ReposPanel.tsx | ◻ |

### review

| anchor | file(s) | covered |
|--------|---------|---------|
| `review-*` | src/web/review/SafeDecisionBar.tsx | ✅ |
| `review-actions` | src/web/review/SafeDecisionBar.tsx | ◻ |
| `review-confirm-reason` | src/web/review/SafeDecisionBar.tsx | ◻ |
| `review-control-fallback` | src/web/review/ReviewPresentationBoundary.tsx | ◻ |
| `review-control-unavailable` | src/web/review/ReviewPresentationBoundary.tsx | ◻ |
| `review-decide` | src/web/TaskDetail.tsx | ◻ |
| `review-decision-error` | src/web/review/SafeDecisionBar.tsx | ◻ |
| `review-decision-recorded` | src/web/review/SafeDecisionBar.tsx | ◻ |
| `review-decision-status` | src/web/review/DecisionBanner.tsx | ◻ |
| `review-evidence-drawer` | src/web/review/EvidenceDrawer.tsx | ✅ |
| `review-human-acknowledgement` | src/web/review/SafeDecisionBar.tsx | ◻ |
| `review-iteration-history` | src/web/review/IterationHistory.tsx | ◻ |
| `review-mode-control` | src/web/review/ReviewPresentationBoundary.tsx | ◻ |
| `review-mode-legacy` | src/web/review/ReviewPresentationBoundary.tsx | ◻ |
| `review-mode-outcome` | src/web/review/ReviewPresentationBoundary.tsx | ✅ |
| `review-more-evidence` | src/web/review/SafeDecisionBar.tsx | ✅ |
| `review-needs-you` | src/web/TaskDetail.tsx | ◻ |
| `review-needs-you-evidence` | src/web/TaskDetail.tsx | ◻ |
| `review-only-flags` | src/web/TaskDetail.tsx | ◻ |
| `review-open-approve` | src/web/review/SafeDecisionBar.tsx | ✅ |
| `review-open-reject` | src/web/review/SafeDecisionBar.tsx | ◻ |
| `review-primary-action` | src/web/TaskDetail.tsx | ◻ |
| `review-read-only` | src/web/review/SafeDecisionBar.tsx | ◻ |
| `review-request-changes` | src/web/review/SafeDecisionBar.tsx | ✅ |
| `review-risk-acknowledgement` | src/web/review/SafeDecisionBar.tsx | ✅ |
| `review-stale-explanation` | src/web/review/ReviewPresentationBoundary.tsx | ◻ |
| `review-verdict` | src/web/TaskDetail.tsx | ◻ |

### reviewer

| anchor | file(s) | covered |
|--------|---------|---------|
| `reviewer-explicit-recovery` | src/web/SettingsPanel.tsx | ◻ |
| `reviewer-health-check` | src/web/SettingsPanel.tsx | ◻ |
| `reviewer-infra-receipt` | src/web/SettingsPanel.tsx | ◻ |
| `reviewer-recovery-error` | src/web/SettingsPanel.tsx | ◻ |

### risk

| anchor | file(s) | covered |
|--------|---------|---------|
| `risk-area-*` | src/web/ReleasesPanel.tsx | ◻ |
| `risk-files` | src/web/ReleasesPanel.tsx | ◻ |
| `risk-lines` | src/web/ReleasesPanel.tsx | ◻ |
| `risk-size` | src/web/ReleasesPanel.tsx | ◻ |

### rollback

| anchor | file(s) | covered |
|--------|---------|---------|
| `rollback-btn` | src/web/ReleasesPanel.tsx | ◻ |

### run

| anchor | file(s) | covered |
|--------|---------|---------|
| `run-brief` | src/web/TaskDetail.tsx | ◻ |
| `run-timeline` | src/web/RunTimeline.tsx | ✅ |
| `run-timeline-kind-*` | src/web/RunTimeline.tsx | ◻ |
| `run-timeline-list` | src/web/RunTimeline.tsx | ◻ |
| `run-timeline-summary` | src/web/RunTimeline.tsx | ✅ |

### salvage

| anchor | file(s) | covered |
|--------|---------|---------|
| `salvage-fork` | src/web/TaskDetail.tsx | ◻ |

### sessions

| anchor | file(s) | covered |
|--------|---------|---------|
| `sessions-list` | src/web/SessionsPanel.tsx | ◻ |

### settings

| anchor | file(s) | covered |
|--------|---------|---------|
| `settings-agent` | src/web/SettingsPanel.tsx | ◻ |
| `settings-ceo` | src/web/SettingsPanel.tsx | ◻ |
| `settings-ceo-open` | src/web/SettingsPanel.tsx | ◻ |
| `settings-claude-policy` | src/web/SettingsPanel.tsx | ◻ |
| `settings-codex-policy` | src/web/SettingsPanel.tsx | ◻ |
| `settings-cost-advisory` | src/web/SettingsPanel.tsx | ◻ |
| `settings-cost-billing-mode` | src/web/SettingsPanel.tsx | ◻ |
| `settings-cost-billing-note` | src/web/SettingsPanel.tsx | ◻ |
| `settings-cost-caps` | src/web/SettingsPanel.tsx | ◻ |
| `settings-cost-enforced` | src/web/SettingsPanel.tsx | ◻ |
| `settings-cost-ledger` | src/web/SettingsPanel.tsx | ◻ |
| `settings-cost-ledger-freshness` | src/web/SettingsPanel.tsx | ◻ |
| `settings-cost-ledger-note` | src/web/SettingsPanel.tsx | ◻ |
| `settings-cost-ledger-status` | src/web/SettingsPanel.tsx | ◻ |
| `settings-cost-level` | src/web/SettingsPanel.tsx | ◻ |
| `settings-cost-meaning` | src/web/SettingsPanel.tsx | ◻ |
| `settings-cost-off` | src/web/SettingsPanel.tsx | ◻ |
| `settings-cost-on` | src/web/SettingsPanel.tsx | ◻ |
| `settings-cost-reasons` | src/web/SettingsPanel.tsx | ◻ |
| `settings-cost-thresholds` | src/web/SettingsPanel.tsx | ◻ |
| `settings-language` | src/web/SettingsPanel.tsx | ◻ |
| `settings-logout` | src/web/SettingsPanel.tsx | ◻ |
| `settings-panel` | src/web/SettingsPanel.tsx | ✅ |
| `settings-provider-policy` | src/web/SettingsPanel.tsx | ◻ |
| `settings-reviewer-health` | src/web/SettingsPanel.tsx | ◻ |
| `settings-sheet-habits` | src/web/SettingsPanel.tsx | ◻ |
| `settings-update` | src/web/SettingsPanel.tsx | ◻ |
| `settings-update-btn` | src/web/SettingsPanel.tsx | ◻ |
| `settings-update-disabled` | src/web/SettingsPanel.tsx | ◻ |
| `settings-update-fail` | src/web/SettingsPanel.tsx | ◻ |
| `settings-update-log` | src/web/SettingsPanel.tsx | ◻ |
| `settings-update-ok` | src/web/SettingsPanel.tsx | ◻ |
| `settings-update-step` | src/web/SettingsPanel.tsx | ◻ |

### sheet

| anchor | file(s) | covered |
|--------|---------|---------|
| `sheet-adaptive-band` | src/web/TaskDetail.tsx | ◻ |
| `sheet-habits-reset` | src/web/SettingsPanel.tsx | ◻ |

### staging

| anchor | file(s) | covered |
|--------|---------|---------|
| `staging-status` | src/web/ReleasesPanel.tsx | ◻ |
| `staging-url` | src/web/ReleasesPanel.tsx | ◻ |
| `staging-verify-elapsed` | src/web/ReleasesPanel.tsx | ◻ |

### succession

| anchor | file(s) | covered |
|--------|---------|---------|
| `succession-canonical` | src/web/SuccessionPanel.tsx | ◻ |
| `succession-choices` | src/web/SuccessionPanel.tsx | ◻ |
| `succession-classifications` | src/web/SuccessionPanel.tsx | ◻ |
| `succession-managed` | src/web/SuccessionPanel.tsx | ◻ |

### task

| anchor | file(s) | covered |
|--------|---------|---------|
| `task-body` | src/web/TaskDetail.tsx | ◻ |
| `task-card` | src/web/TasksPanel.tsx | ◻ |
| `task-card-failed` | src/web/TasksPanel.tsx | ◻ |
| `task-chat-panel` | src/web/TaskDetail.tsx | ◻ |
| `task-detail-close` | src/web/TaskDetail.tsx | ✅ |
| `task-draft-discard` | src/web/CreateForm.tsx | ◻ |
| `task-draft-restored` | src/web/CreateForm.tsx | ◻ |
| `task-failed-banner` | src/web/TaskDetail.tsx | ◻ |
| `task-file-view` | src/web/TaskDetail.tsx | ◻ |
| `task-files` | src/web/TaskDetail.tsx | ◻ |
| `task-list` | src/web/PullToRefresh.tsx | ◻ |
| `task-open-pr` | src/web/TaskDetail.tsx | ◻ |
| `task-retry` | src/web/TaskDetail.tsx | ◻ |
| `task-search` | src/web/TasksPanel.tsx | ◻ |
| `task-search-empty` | src/web/TasksPanel.tsx | ◻ |

### unverified

| anchor | file(s) | covered |
|--------|---------|---------|
| `unverified-*` | src/web/ReleasesPanel.tsx | ◻ |

### verification

| anchor | file(s) | covered |
|--------|---------|---------|
| `verification-stage` | src/web/TaskDetail.tsx | ◻ |

### verify

| anchor | file(s) | covered |
|--------|---------|---------|
| `verify-cancel` | src/web/TaskDetail.tsx | ◻ |
| `verify-force-abort` | src/web/TaskDetail.tsx | ◻ |

### voice

| anchor | file(s) | covered |
|--------|---------|---------|
| `voice-dock` | src/web/VoiceControl.tsx | ◻ |
| `voice-orb` | src/web/VoiceControl.tsx | ◻ |

### waiting

| anchor | file(s) | covered |
|--------|---------|---------|
| `waiting-deps` | src/web/TaskDetail.tsx | ◻ |

### workspace

| anchor | file(s) | covered |
|--------|---------|---------|
| `workspace-succession` | src/web/SuccessionPanel.tsx | ◻ |

## Stale / unknown

### Unknown anchors

_none_

### Unknown task ids

_none_

