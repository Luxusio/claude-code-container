use serde::Serialize;
use std::process::Command;

#[derive(Debug, Serialize)]
struct ContainerInfo {
    name: String,
    status: String,
    id: String,
}

fn list_containers() -> Result<serde_json::Value, String> {
    let output = Command::new("docker")
        .args(["ps", "-a", "--format", "{{.Names}}\t{{.Status}}\t{{.ID}}", "--filter", "name=ccc-"])
        .output()
        .map_err(|e| format!("Failed to run docker: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let containers: Vec<ContainerInfo> = stdout
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(3, '\t').collect();
            if parts.len() >= 3 {
                Some(ContainerInfo {
                    name: parts[0].to_string(),
                    status: parts[1].to_string(),
                    id: parts[2].to_string(),
                })
            } else if parts.len() == 2 {
                Some(ContainerInfo {
                    name: parts[0].to_string(),
                    status: parts[1].to_string(),
                    id: String::new(),
                })
            } else {
                None
            }
        })
        .collect();
    Ok(serde_json::to_value(containers).unwrap())
}

fn start_container(name: &str) -> Result<serde_json::Value, String> {
    let output = Command::new("docker")
        .args(["start", name])
        .output()
        .map_err(|e| format!("Failed to run docker: {}", e))?;
    if output.status.success() {
        Ok(serde_json::json!(format!("Started {}", name)))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("docker start failed: {}", stderr.trim()))
    }
}

fn stop_container(name: &str) -> Result<serde_json::Value, String> {
    let output = Command::new("docker")
        .args(["stop", name])
        .output()
        .map_err(|e| format!("Failed to run docker: {}", e))?;
    if output.status.success() {
        Ok(serde_json::json!(format!("Stopped {}", name)))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("docker stop failed: {}", stderr.trim()))
    }
}

fn remove_container(name: &str) -> Result<serde_json::Value, String> {
    let output = Command::new("docker")
        .args(["rm", "-f", name])
        .output()
        .map_err(|e| format!("Failed to run docker: {}", e))?;
    if output.status.success() {
        Ok(serde_json::json!(format!("Removed {}", name)))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("docker rm failed: {}", stderr.trim()))
    }
}

fn dispatch_json(line: &str) -> String {
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return serde_json::json!({"ok":false,"error":format!("parse error: {}",e)}).to_string(),
    };
    let cmd = v["cmd"].as_str().unwrap_or("");
    let name = v["name"].as_str().unwrap_or("");

    let result = match cmd {
        "list_containers" => list_containers(),
        "start_container" => start_container(name),
        "stop_container" => stop_container(name),
        "remove_container" => remove_container(name),
        _ => Err(format!("Unknown command: {}", cmd)),
    };

    let response = match result {
        Ok(data) => serde_json::json!({"ok": true, "data": data}),
        Err(e) => serde_json::json!({"ok": false, "error": e}),
    };
    response.to_string()
}

fn main() {
    use std::io::{self, BufRead};

    // Check if stdin has data (piped)
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();

    if let Some(Ok(line)) = lines.next() {
        // stdin JSON mode
        let line = line.trim().to_string();
        if !line.is_empty() {
            let result = dispatch_json(&line);
            println!("{}", result);
            return;
        }
    }

    // CLI args mode (fallback)
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("");
    let name = args.get(2).map(|s| s.as_str()).unwrap_or("");

    let result = match cmd {
        "list_containers" => list_containers(),
        "start_container" => start_container(name),
        "stop_container" => stop_container(name),
        "remove_container" => remove_container(name),
        _ => Err(format!("Unknown command: {}", cmd)),
    };

    let response = match result {
        Ok(data) => serde_json::json!({"ok": true, "data": data}),
        Err(e) => serde_json::json!({"ok": false, "error": e}),
    };

    println!("{}", response);
}
