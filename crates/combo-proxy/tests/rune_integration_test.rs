#[tokio::test]
async fn spawns_real_rune_and_becomes_healthy() {
    if std::env::var("COMBO_RUNE_IT").is_err() {
        eprintln!("skipping: set COMBO_RUNE_IT=1 and have `crush` on PATH");
        return;
    }
    let bin = std::env::var("COMBO_CRUSH_BIN").unwrap_or_else(|_| "crush".into());
    let mgr = combo_proxy::rune::RuneManager::new(bin);
    let upstream = mgr
        .ensure_running()
        .await
        .expect("rune should start and become healthy");
    assert!(mgr.health_check(&upstream).await);
    mgr.shutdown().await.ok();
}
