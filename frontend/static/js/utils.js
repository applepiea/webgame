// utils.js

/**
 * 시나리오 ID와 이미지 경로를 받아 유효한 이미지 URL을 반환하는 헬퍼 함수
 * @param {string} scenarioId - 시나리오 ID (기본값: scenario_01)
 * @param {string} imagePath - 서버에서 넘어온 이미지 경로 또는 파일명
 * @returns {string} 완성된 이미지 접근 URL
 */
export function getCharacterImageUrl(scenarioId, imagePath) {
    if (!imagePath) {
        return '/data/default_avatar.png'; // 이미지가 없을 때의 대체 기본 이미지
    }

    // 만약 절대 경로(http 등)이거나 이미 /data로 시작한다면 그대로 반환
    if (imagePath.startsWith('http') || imagePath.startsWith('/data')) {
        return imagePath;
    }

    // 슬래시(/) 누락 방지 및 경로 정돈
    const cleanPath = imagePath.startsWith('/') ? imagePath : `/${imagePath}`;
    const currentScenario = scenarioId || 'scenario_01';

    // 만약 파일명만 덩그러니 들어온 경우(예: 'dalrae.PNG')를 위한 방어 로직
    // 경로에 'images'나 'character'가 포함되어 있지 않다면 기본 폴더 구조를 자동 보정해 줍니다.
    if (!cleanPath.includes('images') && !cleanPath.includes('character')) {
        return `/data/${currentScenario}/images/character${cleanPath}`;
    }

    return `/data/${currentScenario}${cleanPath}`;
}

/**
 * 파일명이 그림 확장자(png, jpg, jpeg, gif, webp 등)를 포함하는지 확인하는 유틸리티
 */
export function isImageFile(filename) {
    if (!filename) return false;
    const imageExtensions = /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i;
    return imageExtensions.test(filename);
}