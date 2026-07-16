use std::collections::HashMap;

pub struct ApiConfig {
    pub base_url: String,
}

pub type QueryMap = HashMap<String, String>;

#[tauri::command]
pub async fn api_request(
    config: tauri::State<'_, ApiConfig>,
    method: String,
    path: String,
    query: Option<QueryMap>,
    body: Option<String>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("JNMusic/1.0")
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let base = config.base_url.trim_end_matches('/');
    let url_path = if path.starts_with('/') {
        path.clone()
    } else {
        format!("/{}", path)
    };
    let url = format!("{}{}", base, url_path);

    let mut req = match method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        _ => return Err(format!("Unsupported HTTP method: {}", method)),
    };

    if let Some(ref params) = query {
        req = req.query(params);
    }

    if let Some(ref body_str) = body {
        req = req
            .header("Content-Type", "application/json")
            .body(body_str.clone());
    }

    let response = req.send().await.map_err(|e| format!("Request failed: {}", e))?;

    let body_text = response.text().await.map_err(|e| format!("Failed to read response: {}", e))?;

    Ok(body_text)
}

#[tauri::command]
pub async fn fetch_audio_by_track(
    config: tauri::State<'_, ApiConfig>,
    track_id: String,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("JNMusic/1.0")
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Build client: {}", e))?;

    let stream_url = format!("{}/api/v1/proxy/stream-audio/{}", 
        config.base_url.trim_end_matches('/'), track_id);
    eprintln!("[audio] downloading: {}", stream_url);

    let resp = client.get(&stream_url)
        .send()
        .await
        .map_err(|e| format!("Stream request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Backend returned HTTP {}", resp.status()));
    }

    let content_type = resp.headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("audio/flac")
        .to_string();

    let ext = if content_type.contains("flac") { "flac" }
        else if content_type.contains("mp3") { "mp3" }
        else if content_type.contains("ogg") { "ogg" }
        else if content_type.contains("wav") { "wav" }
        else { "bin" };

    let bytes = resp.bytes().await
        .map_err(|e| format!("Read audio body failed: {}", e))?;

    let temp_dir = std::env::temp_dir();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let file_name = format!("{}_{}.{}", track_id, ts, ext);
    let file_path = temp_dir.join(&file_name);

    std::fs::write(&file_path, &bytes)
        .map_err(|e| format!("Save audio file failed: {}", e))?;

    eprintln!("[audio] saved to: {:?} ({} bytes)", file_path, bytes.len());
    Ok(file_path.to_string_lossy().to_string())
}
