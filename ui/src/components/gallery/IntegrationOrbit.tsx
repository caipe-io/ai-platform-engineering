"use client";

import { BrandLogo } from "@/components/brand/BrandLogo";
import { getConfig } from "@/lib/config";
import { motion } from "framer-motion";
import Image from "next/image";
import { useMemo } from "react";

// Integration logos - simple single-color icons for small containers
// Sources: simpleicons.org, devicons
const integrations = [
  {
    name: "ArgoCD",
    color: "#FFFFFF",
    // Full ArgoCD logo from public folder
    icon: (
      <div className="w-full h-full flex items-center justify-center" style={{ transform: 'scale(1.5)' }}>
      <svg xmlns="http://www.w3.org/2000/svg" xmlnsXlink="http://www.w3.org/1999/xlink" viewBox="0 0 128 128" className="w-full h-full">
        <defs>
          <clipPath id="argocd-original-e"><path d="M42 41h44v51H42zm0 0"/></clipPath>
          <clipPath id="argocd-original-d"><path d="M0 0h128v128H0z"/></clipPath>
          <clipPath id="argocd-original-c"><path d="M0 0h128v128H0z"/></clipPath>
          <clipPath id="argocd-original-f"><path d="M85.695 41.133l-2.55 58.238H44.887l-2.125-58.238"/></clipPath>
          <clipPath id="argocd-original-b"><path d="M0 0h128v128H0z"/></clipPath>
          <mask id="argocd-original-l"><g filter="url(#argocd-original-a)"><path d="M0 0h128v128H0z" fillOpacity=".251"/></g></mask>
          <mask id="argocd-original-h"><g filter="url(#argocd-original-a)"><path d="M0 0h128v128H0z" fillOpacity=".22"/></g></mask>
          <mask id="argocd-original-j"><g filter="url(#argocd-original-a)"><path d="M0 0h128v128H0z" fillOpacity=".502"/></g></mask>
          <g id="argocd-original-i" clipPath="url(#argocd-original-b)"><path d="M58.488 30.508a2.974 2.974 0 11-5.948-.003 2.974 2.974 0 015.948.003zm0 0" fill="#fbdfc3"/></g>
          <g id="argocd-original-g" clipPath="url(#argocd-original-c)"><path d="M84.422 65.363s2.55-22.531-.852-31.031C77.195 19.453 62.316 20.73 62.316 20.73s8.5 3.399 8.926 16.153c.426 8.926 0 22.105 0 22.105zm0 0" fill="#e34e3b"/></g>
          <g id="argocd-original-k" clipPath="url(#argocd-original-d)"><path d="M83.145 90.867V87.47c-5.95 3.398-12.329 6.8-19.977 6.8-8.504 0-14.031-3.824-19.555-6.8l.422 3.398s6.38 6.805 19.555 6.805c12.328-.426 19.555-6.805 19.555-6.805zm0 0" fill="#e9654b"/></g>
          <filter id="argocd-original-a" filterUnits="objectBoundingBox" x="0%" y="0%" width="100%" height="100%"><feColorMatrix in="SourceGraphic" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0"/></filter>
        </defs>
        <path d="M44.035 89.594s-.847 2.55-2.125 3.824a3.844 3.844 0 01-2.972 1.277 49.946 49.946 0 01-6.38 1.274s2.977.426 6.38.851c1.273 0 1.273 0 2.124.426 2.126 0 2.973-1.277 2.973-1.277zm39.11 0s.851 2.55 2.125 3.824a3.858 3.858 0 002.976 1.277 49.8 49.8 0 006.375 1.274s-2.973.426-6.8.851c-1.274 0-1.274 0-2.126.426-2.55 0-2.976-1.277-2.976-1.277zm0 0" fill="#e9654b"/>
        <path d="M109.926 47.508c0 25.355-20.555 45.91-45.91 45.91-25.356 0-45.91-20.555-45.91-45.91 0-25.352 20.554-45.906 45.91-45.906 25.355 0 45.91 20.554 45.91 45.906zm0 0" fill="#b6cfea"/>
        <path d="M108.227 47.508c0 24.418-19.793 44.21-44.211 44.21-24.414 0-44.207-19.792-44.207-44.21C19.809 23.094 39.602 3.3 64.016 3.3c24.418 0 44.21 19.793 44.21 44.207zm0 0" fill="#e6f5f8"/>
        <path d="M100.148 48.36c0 19.956-16.175 36.132-36.132 36.132-19.954 0-36.133-16.176-36.133-36.133 0-19.953 16.18-36.132 36.133-36.132 19.957 0 36.132 16.18 36.132 36.132zm0 0" fill="#d0e8f0"/>
        <path d="M42.762 65.363s2.976 48.035 2.976 48.887c0 .422.426 1.273-1.703 2.125-2.125.848-8.926 2.55-8.926 2.55h10.203c4.676 0 4.676-3.827 4.676-4.675 0-.852 1.274-19.129 1.274-19.129s.425 21.68.425 22.527c0 .852-.425 2.125-3.398 2.977-2.125.426-8.504 1.7-8.504 1.7h9.778c5.953 0 5.953-3.825 5.953-3.825l1.273-19.129s.426 19.129.426 21.254c0 1.7-1.274 2.977-5.953 3.824-2.973.852-6.801 1.703-6.801 1.703h11.055c5.523-.425 6.375-4.254 6.375-4.254l9.351-47.609zm0 0" fill="#ee794b"/>
        <path d="M85.27 65.363s-2.973 48.035-2.973 48.887c0 .422-.426 1.273 1.7 2.125 2.124.848 8.925 2.55 8.925 2.55H82.719c-4.676 0-4.676-3.827-4.676-4.675 0-.852-1.273-19.129-1.273-19.129s-.426 21.68-.426 22.527c0 .852.426 2.125 3.402 2.977l8.5 1.7H78.47c-5.95 0-5.95-3.825-5.95-3.825l-1.277-19.129s-.426 19.129-.426 21.254c0 1.7 1.278 2.977 5.954 3.824 2.976.852 6.8 1.703 6.8 1.703H72.52c-5.528-.425-6.38-4.254-6.38-4.254L56.79 74.29zm.425-23.379c0 11.903-9.777 21.254-21.254 21.254-11.476 0-21.254-9.777-21.254-21.254 0-11.476 9.778-21.254 21.254-21.254 11.477 0 21.254 9.352 21.254 21.254zm0 0" fill="#ee794b"/>
        <g clipPath="url(#argocd-original-e)"><g clipPath="url(#argocd-original-f)"><path d="M102.273 53.46c0 20.895-16.937 37.833-37.832 37.833-20.894 0-37.832-16.938-37.832-37.832 0-20.895 16.938-37.832 37.832-37.832 20.895 0 37.832 16.937 37.832 37.832zm0 0" fill="#ee794b"/></g></g>
        <use xlinkHref="#argocd-original-g" mask="url(#argocd-original-h)"/>
        <use xlinkHref="#argocd-original-i" mask="url(#argocd-original-j)"/>
        <path d="M71.668 73.863c0 7.227-3.402 11.907-7.652 11.907s-7.653-5.528-7.653-12.754c0 0 3.403 6.8 8.078 6.8 4.676 0 7.227-5.953 7.227-5.953zm0 0" fill="#010101"/>
        <path d="M71.668 73.863c0 4.68-3.402 7.227-7.652 7.227s-7.227-3.399-7.227-7.649c0 0 3.402 4.25 8.078 4.25 4.676 0 6.801-3.828 6.801-3.828zm0 0" fill="#fff"/>
        <path d="M92.07 53.887c0 7.277-5.898 13.175-13.175 13.175-7.278 0-13.18-5.898-13.18-13.175 0-7.278 5.902-13.18 13.18-13.18 7.277 0 13.175 5.902 13.175 13.18zm-29.754 0c0 7.277-5.902 13.175-13.18 13.175-7.277 0-13.175-5.898-13.175-13.175 0-7.278 5.898-13.18 13.176-13.18 7.277 0 13.18 5.902 13.18 13.18zm0 0" fill="#e9654b"/>
        <path d="M89.098 53.887c0 5.633-4.57 10.203-10.203 10.203-5.633 0-10.204-4.57-10.204-10.203 0-5.637 4.57-10.203 10.204-10.203 5.632 0 10.203 4.566 10.203 10.203zm-30.61 0c0 5.633-4.566 10.203-10.199 10.203-5.637 0-10.203-4.57-10.203-10.203a10.201 10.201 0 0110.203-10.203c5.633 0 10.2 4.566 10.2 10.203zm0 0" fill="#fff"/>
        <path d="M51.262 52.61a2.975 2.975 0 11-5.95.003 2.975 2.975 0 015.95-.004zm30.609 0a2.976 2.976 0 11-5.951.001 2.976 2.976 0 015.951-.002zm0 0" fill="#010101"/>
        <path d="M17.258 58.988a2.005 2.005 0 01-2.125-2.125V39.86a2.008 2.008 0 01.582-1.543 2.008 2.008 0 011.543-.582 2.005 2.005 0 012.125 2.125v17.004c.035.57-.18 1.133-.586 1.54a2.008 2.008 0 01-1.54.585zm92.668 0a2.003 2.003 0 01-1.54-.586 2.008 2.008 0 01-.585-1.539V39.86a2.011 2.011 0 01.586-1.543 2 2 0 011.539-.582 2 2 0 011.539.582c.41.407.62.97.586 1.543v17.004a1.994 1.994 0 01-.586 1.54 2.003 2.003 0 01-1.54.585zm0 0" fill="#b6cfea"/>
        <path d="M51.688 13.504a2.125 2.125 0 11-4.25 0 2.125 2.125 0 014.25 0zM34.262 70.89a1.559 1.559 0 01-1.278-.425c-5.101-6.375-7.652-14.453-7.652-22.531a37.933 37.933 0 015.102-19.13 41.641 41.641 0 0113.601-13.6 1.873 1.873 0 012.13.425 1.874 1.874 0 01-.427 2.125 34.305 34.305 0 00-17.43 29.754 33.487 33.487 0 007.227 20.832c.426.426.426 1.7-.426 2.125-.425.426-.425.426-.847.426zm0 0" fill="#fff"/>
        <use xlinkHref="#argocd-original-k" mask="url(#argocd-original-l)"/>
      </svg>
      </div>
    )
  },
  {
    name: "AWS",
    color: "#FFFFFF",
    // Full AWS logo from public folder
    icon: (
      <div className="w-full h-full flex items-center justify-center" style={{ transform: 'scale(1.5)' }}>
      <svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
        <path fill="#252f3e" d="M36.379 53.64c0 1.56.168 2.825.465 3.75.336.926.758 1.938 1.347 3.032.207.336.293.672.293.969 0 .418-.254.84-.8 1.261l-2.653 1.77c-.379.25-.758.379-1.093.379-.422 0-.844-.211-1.266-.59a13.28 13.28 0 0 1-1.516-1.98 34.153 34.153 0 0 1-1.304-2.485c-3.282 3.875-7.41 5.813-12.38 5.813-3.535 0-6.355-1.012-8.421-3.032-2.063-2.023-3.114-4.718-3.114-8.086 0-3.578 1.262-6.484 3.833-8.671 2.566-2.192 5.976-3.286 10.316-3.286 1.43 0 2.902.125 4.46.336 1.56.211 3.161.547 4.845.926v-3.074c0-3.2-.676-5.43-1.98-6.734C26.061 32.633 23.788 32 20.546 32c-1.473 0-2.988.168-4.547.547a33.416 33.416 0 0 0-4.547 1.433c-.676.293-1.18.461-1.473.547-.296.082-.507.125-.675.125-.59 0-.883-.422-.883-1.304v-2.063c0-.676.082-1.18.293-1.476.21-.293.59-.586 1.18-.883 1.472-.758 3.242-1.39 5.304-1.895 2.063-.547 4.254-.8 6.57-.8 5.008 0 8.672 1.136 11.032 3.41 2.316 2.273 3.492 5.726 3.492 10.359v13.64Zm-17.094 6.403c1.387 0 2.82-.254 4.336-.758 1.516-.508 2.863-1.433 4-2.695.672-.8 1.18-1.684 1.43-2.695.254-1.012.422-2.23.422-3.665v-1.765a34.401 34.401 0 0 0-3.871-.719 31.816 31.816 0 0 0-3.961-.25c-2.82 0-4.883.547-6.274 1.684-1.387 1.136-2.062 2.734-2.062 4.84 0 1.98.504 3.453 1.558 4.464 1.012 1.051 2.485 1.559 4.422 1.559Zm33.809 4.547c-.758 0-1.262-.125-1.598-.422-.34-.254-.633-.84-.887-1.64L40.715 29.98c-.25-.843-.38-1.39-.38-1.687 0-.672.337-1.05 1.013-1.05h4.125c.8 0 1.347.124 1.644.421.336.25.59.84.84 1.64l7.074 27.876 6.57-27.875c.208-.84.462-1.39.797-1.64.34-.255.93-.423 1.688-.423h3.367c.8 0 1.348.125 1.684.422.336.25.633.84.8 1.64l6.653 28.212 7.285-28.211c.25-.84.547-1.39.84-1.64.336-.255.887-.423 1.644-.423h3.914c.676 0 1.055.336 1.055 1.051 0 .21-.043.422-.086.676-.043.254-.125.59-.293 1.05L80.801 62.57c-.254.84-.547 1.387-.887 1.64-.336.255-.883.423-1.598.423h-3.62c-.801 0-1.348-.13-1.684-.422-.34-.297-.633-.844-.801-1.684l-6.527-27.16-6.485 27.117c-.21.844-.46 1.391-.8 1.684-.337.297-.926.422-1.684.422Zm54.105 1.137c-2.187 0-4.379-.254-6.484-.758-2.106-.504-3.746-1.055-4.84-1.684-.676-.379-1.137-.8-1.305-1.18a2.919 2.919 0 0 1-.254-1.18v-2.148c0-.882.336-1.304.97-1.304.25 0 .503.043.757.129.25.082.629.25 1.05.418a23.102 23.102 0 0 0 4.634 1.476c1.683.336 3.324.504 5.011.504 2.653 0 4.715-.465 6.145-1.39 1.433-.926 2.191-2.274 2.191-4 0-1.18-.379-2.145-1.136-2.946-.758-.8-2.192-1.516-4.254-2.191l-6.106-1.895c-3.074-.969-5.348-2.398-6.734-4.293-1.39-1.855-2.106-3.918-2.106-6.105 0-1.77.38-3.328 1.137-4.676a10.829 10.829 0 0 1 3.031-3.453c1.262-.965 2.696-1.684 4.38-2.188 1.683-.504 3.452-.715 5.304-.715.926 0 1.894.043 2.82.168.969.125 1.852.293 2.738.461.84.211 1.641.422 2.399.676.758.254 1.348.504 1.77.758.59.336 1.011.672 1.261 1.05.254.34.379.802.379 1.391v1.98c0 .884-.336 1.348-.969 1.348-.336 0-.883-.171-1.597-.507-2.403-1.094-5.098-1.641-8.086-1.641-2.399 0-4.293.379-5.598 1.18-1.309.797-1.98 2.02-1.98 3.746 0 1.18.421 2.191 1.261 2.988.844.8 2.403 1.602 4.633 2.316l5.98 1.895c3.032.969 5.22 2.316 6.524 4.043 1.305 1.727 1.938 3.707 1.938 5.895 0 1.812-.38 3.453-1.094 4.882-.758 1.434-1.77 2.696-3.074 3.707-1.305 1.051-2.864 1.809-4.672 2.36-1.895.586-3.875.883-6.024.883Zm0 0"/>
        <path fill="#f90" d="M118 73.348c-4.432.063-9.664 1.052-13.621 3.832-1.223.883-1.012 2.062.336 1.894 4.508-.547 14.44-1.726 16.21.547 1.77 2.23-1.976 11.62-3.663 15.79-.504 1.26.59 1.769 1.726.8 7.41-6.231 9.348-19.242 7.832-21.137-.757-.925-4.388-1.79-8.82-1.726zM1.63 75.859c-.927.116-1.347 1.236-.368 2.121 16.508 14.902 38.359 23.872 62.613 23.872 17.305 0 37.43-5.43 51.281-15.66 2.273-1.688.297-4.254-2.02-3.204-15.534 6.57-32.421 9.77-47.788 9.77-22.778 0-44.8-6.273-62.653-16.633-.39-.231-.755-.304-1.064-.266z"/>
      </svg>
      </div>
    )
  },
  {
    name: "GitHub",
    color: "#181717",
    // GitHub logo
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
        <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
      </svg>
    )
  },
  {
    name: "Jira",
    color: "#FFFFFF",
    // Full Jira logo from public folder
    icon: (
      <svg viewBox="0 0 256 256" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlnsXlink="http://www.w3.org/1999/xlink" preserveAspectRatio="xMidYMid" className="w-full h-full">
        <defs>
          <linearGradient x1="98.0308675%" y1="0.160599572%" x2="58.8877062%" y2="40.7655246%" id="linearGradient-1">
            <stop stopColor="#0052CC" offset="18%"/>
            <stop stopColor="#2684FF" offset="100%"/>
          </linearGradient>
          <linearGradient x1="100.665247%" y1="0.45503212%" x2="55.4018095%" y2="44.7269807%" id="linearGradient-2">
            <stop stopColor="#0052CC" offset="18%"/>
            <stop stopColor="#2684FF" offset="100%"/>
          </linearGradient>
        </defs>
        <g>
          <path d="M244.657778,0 L121.706667,0 C121.706667,14.7201046 127.554205,28.837312 137.962891,39.2459977 C148.371577,49.6546835 162.488784,55.5022222 177.208889,55.5022222 L199.857778,55.5022222 L199.857778,77.3688889 C199.877391,107.994155 224.699178,132.815943 255.324444,132.835556 L255.324444,10.6666667 C255.324444,4.77562934 250.548815,3.60722001e-16 244.657778,0 Z" fill="#2684FF"/>
          <path d="M183.822222,61.2622222 L60.8711111,61.2622222 C60.8907238,91.8874888 85.7125112,116.709276 116.337778,116.728889 L138.986667,116.728889 L138.986667,138.666667 C139.025905,169.291923 163.863607,194.097803 194.488889,194.097778 L194.488889,71.9288889 C194.488889,66.0378516 189.71326,61.2622222 183.822222,61.2622222 Z" fill="url(#linearGradient-1)"/>
          <path d="M122.951111,122.488889 L0,122.488889 C3.75391362e-15,153.14192 24.8491913,177.991111 55.5022222,177.991111 L78.2222222,177.991111 L78.2222222,199.857778 C78.241767,230.45532 103.020285,255.265647 133.617778,255.324444 L133.617778,133.155556 C133.617778,127.264518 128.842148,122.488889 122.951111,122.488889 Z" fill="url(#linearGradient-2)"/>
        </g>
      </svg>
    )
  },
  {
    name: "GitLab",
    color: "#FC6D26",
    // GitLab logo
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
        <path d="m23.6 9.593-.033-.086L20.3.98a.851.851 0 0 0-.336-.405.875.875 0 0 0-1.009.07.875.875 0 0 0-.29.44l-2.209 6.76H7.551l-2.21-6.76a.857.857 0 0 0-.29-.44.875.875 0 0 0-1.009-.07.858.858 0 0 0-.336.404L.437 9.507l-.033.086a6.066 6.066 0 0 0 2.012 7.01l.01.008.028.02 4.98 3.727 2.462 1.863 1.5 1.132a1.008 1.008 0 0 0 1.22 0l1.499-1.132 2.461-1.863 5.008-3.748.012-.01a6.062 6.062 0 0 0 2.004-7.007z"/>
      </svg>
    )
  },
  {
    name: "Splunk",
    color: "#65A637",
    // Full Splunk logo from public folder
    icon: (
      <svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
        <title>splunk</title>
        <g id="Layer_2" data-name="Layer 2">
          <g id="invisible_box" data-name="invisible box">
            <rect width="48" height="48" fill="none"/>
          </g>
          <g id="Q3_icons" data-name="Q3 icons">
            <path d="M37.5,4h-27A6.5,6.5,0,0,0,4,10.5v27A6.5,6.5,0,0,0,10.5,44h27A6.5,6.5,0,0,0,44,37.5v-27A6.5,6.5,0,0,0,37.5,4ZM33.6,26.1c0,.1,0,.2-.2.3L14.7,35.8c-.1.1-.3-.1-.3-.2V30.8c0-.1,0-.2.1-.2l13.6-6.8L14.5,16.9c-.1,0-.1-.1-.1-.2V11.9c0-.1.2-.3.3-.2l18.7,9.4a.5.5,0,0,1,.2.4Z" fill="currentColor"/>
          </g>
        </g>
      </svg>
    )
  },
  {
    name: "Confluence",
    color: "#FFFFFF",
    // Full Confluence logo from public folder
    icon: (
      <svg height="2400" viewBox="-.02238712 .04 256.07238712 245.94" width="2500" xmlns="http://www.w3.org/2000/svg" xmlnsXlink="http://www.w3.org/1999/xlink" className="w-full h-full">
        <linearGradient id="a"><stop offset="0" stopColor="#0052cc"/><stop offset=".92" stopColor="#2380fb"/><stop offset="1" stopColor="#2684ff"/></linearGradient>
        <linearGradient id="b" gradientUnits="userSpaceOnUse" x1="243.35" x2="83.149" xlinkHref="#a" y1="261.618" y2="169.549"/>
        <linearGradient id="c" gradientUnits="userSpaceOnUse" x1="12.633" x2="172.873" xlinkHref="#a" y1="-15.48" y2="76.589"/>
        <path d="m9.11 187.79c-2.64 4.3-5.63 9.34-7.99 13.33-.52.89-.85 1.88-1 2.9a8.13 8.13 0 0 0 .16 3.07c.24 1.01.68 1.95 1.28 2.79s1.36 1.56 2.23 2.12l53.03 32.69c.91.57 1.94.95 3.01 1.12 1.06.17 2.16.13 3.21-.13s2.04-.72 2.91-1.36 1.6-1.45 2.15-2.38c2.14-3.56 4.85-8.17 7.76-13.09 21.02-34.47 42.32-30.25 80.37-12.16l52.6 24.94a8.13 8.13 0 0 0 6.35.29c1.02-.38 1.96-.96 2.75-1.71.8-.75 1.43-1.65 1.87-2.65l25.25-56.93c.43-.96.67-1.99.7-3.04.04-1.04-.13-2.09-.49-3.07s-.9-1.89-1.6-2.67-1.54-1.41-2.49-1.88c-11.09-5.22-33.16-15.49-52.94-25.17-71.95-34.71-132.66-32.42-179.12 42.99z" fill="url(#b)"/>
        <path d="m246.88 58.38c2.67-4.3 5.66-9.33 7.99-13.32.53-.91.88-1.92 1.03-2.97.15-1.04.09-2.11-.17-3.13a8.155 8.155 0 0 0 -1.36-2.83 8.09 8.09 0 0 0 -2.33-2.11l-52.95-32.69c-.92-.57-1.94-.95-3.01-1.12s-2.16-.12-3.21.13c-1.05.26-2.04.72-2.91 1.36s-1.6 1.45-2.16 2.38c-2.09 3.56-4.85 8.17-7.76 13.09-21.1 34.63-42.2 30.41-80.29 12.32l-52.55-24.95c-.98-.47-2.04-.75-3.12-.81-1.08-.07-2.17.09-3.19.45s-1.96.92-2.76 1.65c-.81.73-1.45 1.61-1.91 2.59l-25.25 57.09a8.191 8.191 0 0 0 -.23 6.13c.36.99.91 1.9 1.61 2.68s1.55 1.42 2.5 1.88c11.13 5.23 33.2 15.49 52.94 25.18 71.76 34.7 132.66 32.42 179.09-43z" fill="url(#c)"/>
      </svg>
    )
  },
  {
    name: "Webex",
    color: "#FFFFFF",
    // Webex logo from public folder
    icon: (
      <div className="w-full h-full flex items-center justify-center" style={{ transform: 'scale(1.5)' }}>
        <Image src="/webex.svg" alt="Webex" width={128} height={128} className="w-full h-full object-contain" />
      </div>
    )
  },
  {
    name: "Kubernetes",
    color: "#FFFFFF",
    // Full Kubernetes logo from public folder
    icon: (
      <div className="w-full h-full flex items-center justify-center" style={{ transform: 'scale(1.5)' }}>
        <Image src="/kubernetes.svg" alt="Kubernetes" width={128} height={128} className="w-full h-full object-contain" />
      </div>
    )
  },
  {
    name: "Slack",
    color: "#4A154B",
    // Full Slack logo from public folder
    icon: (
      <svg viewBox="-2.45 0 2452.5 2452.5" enableBackground="new 0 0 2447.6 2452.5" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
        <g clipRule="evenodd" fillRule="evenodd">
          <path d="m897.4 0c-135.3.1-244.8 109.9-244.7 245.2-.1 135.3 109.5 245.1 244.8 245.2h244.8v-245.1c.1-135.3-109.5-245.1-244.9-245.3.1 0 .1 0 0 0m0 654h-652.6c-135.3.1-244.9 109.9-244.8 245.2-.2 135.3 109.4 245.1 244.7 245.3h652.7c135.3-.1 244.9-109.9 244.8-245.2.1-135.4-109.5-245.2-244.8-245.3z" fill="#36c5f0"/>
          <path d="m2447.6 899.2c.1-135.3-109.5-245.1-244.8-245.2-135.3.1-244.9 109.9-244.8 245.2v245.3h244.8c135.3-.1 244.9-109.9 244.8-245.3zm-652.7 0v-654c.1-135.2-109.4-245-244.7-245.2-135.3.1-244.9 109.9-244.8 245.2v654c-.2 135.3 109.4 245.1 244.7 245.3 135.3-.1 244.9-109.9 244.8-245.3z" fill="#2eb67d"/>
          <path d="m1550.1 2452.5c135.3-.1 244.9-109.9 244.8-245.2.1-135.3-109.5-245.1-244.8-245.2h-244.8v245.2c-.1 135.2 109.5 245 244.8 245.2zm0-654.1h652.7c135.3-.1 244.9-109.9 244.8-245.2.2-135.3-109.4-245.1-244.7-245.3h-652.7c-135.3.1-244.9 109.9-244.8 245.2-.1 135.4 109.4 245.2 244.7 245.3z" fill="#ecb22e"/>
          <path d="m0 1553.2c-.1 135.3 109.5 245.1 244.8 245.2 135.3-.1 244.9-109.9 244.8-245.2v-245.2h-244.8c-135.3.1-244.9 109.9-244.8 245.2zm652.7 0v654c-.2 135.3 109.4 245.1 244.7 245.3 135.3-.1 244.9-109.9 244.8-245.2v-653.9c.2-135.3-109.4-245.1-244.7-245.3-135.4 0-244.9 109.8-244.8 245.1 0 0 0 .1 0 0" fill="#e01e5a"/>
        </g>
      </svg>
    )
  },
  {
    name: "Backstage",
    color: "#FFFFFF",
    // Full Backstage logo from public folder
    icon: (
      <div className="w-full h-full flex items-center justify-center" style={{ transform: 'scale(1.5)' }}>
      <svg xmlns="http://www.w3.org/2000/svg" id="Assets" viewBox="0 0 337.46 428.5" className="w-full h-full">
        <defs><style>{`.cls-1{fill:#7df3e1}`}</style></defs>
        <title>04 Icon_Teal</title>
        <path d="M303,166.05a80.69,80.69,0,0,0,13.45-10.37c.79-.77,1.55-1.53,2.3-2.3a83.12,83.12,0,0,0,7.93-9.38A63.69,63.69,0,0,0,333,133.23a48.58,48.58,0,0,0,4.35-16.4c1.49-19.39-10-38.67-35.62-54.22L198.56,0,78.3,115.23,0,190.25l108.6,65.91a111.59,111.59,0,0,0,57.76,16.41c24.92,0,48.8-8.8,66.42-25.69,19.16-18.36,25.52-42.12,13.7-61.87a49.22,49.22,0,0,0-6.8-8.87A89.17,89.17,0,0,0,259,178.29h.15a85.08,85.08,0,0,0,31-5.79A80.88,80.88,0,0,0,303,166.05ZM202.45,225.86c-19.32,18.51-50.4,21.23-75.7,5.9L51.61,186.15l67.45-64.64,76.41,46.38C223,184.58,221.49,207.61,202.45,225.86Zm8.93-82.22-70.65-42.89L205.14,39,274.51,81.1c25.94,15.72,29.31,37,10.55,55A60.69,60.69,0,0,1,211.38,143.64Zm29.86,190c-19.57,18.75-46.17,29.09-74.88,29.09a123.73,123.73,0,0,1-64.1-18.2L0,282.52v24.67L108.6,373.1a111.6,111.6,0,0,0,57.76,16.42c24.92,0,48.8-8.81,66.42-25.69,12.88-12.34,20-27.13,19.68-41.49v-1.79A87.27,87.27,0,0,1,241.24,333.68Zm0-39c-19.57,18.75-46.17,29.08-74.88,29.08a123.81,123.81,0,0,1-64.1-18.19L0,243.53v24.68l108.6,65.91a111.6,111.6,0,0,0,57.76,16.42c24.92,0,48.8-8.81,66.42-25.69,12.88-12.34,20-27.13,19.68-41.5v-1.78A87.27,87.27,0,0,1,241.24,294.7Zm0-39c-19.57,18.76-46.17,29.09-74.88,29.09a123.81,123.81,0,0,1-64.1-18.19L0,204.55v24.68l108.6,65.91a111.59,111.59,0,0,0,57.76,16.41c24.92,0,48.8-8.8,66.42-25.68,12.88-12.35,20-27.13,19.68-41.5v-1.82A86.09,86.09,0,0,1,241.24,255.71Zm83.7,25.74a94.15,94.15,0,0,1-60.2,25.86h0V334a81.6,81.6,0,0,0,51.74-22.37c14-13.38,21.14-28.11,21-42.64v-2.19A94.92,94.92,0,0,1,324.94,281.45Zm-83.7,91.21c-19.57,18.76-46.17,29.09-74.88,29.09a123.73,123.73,0,0,1-64.1-18.2L0,321.5v24.68l108.6,65.9a111.6,111.6,0,0,0,57.76,16.42c24.92,0,48.8-8.8,66.42-25.69,12.88-12.34,20-27.13,19.68-41.49v-1.79A86.29,86.29,0,0,1,241.24,372.66ZM327,162.45c-.68.69-1.35,1.38-2.05,2.06a94.37,94.37,0,0,1-10.64,8.65,91.35,91.35,0,0,1-11.6,7,94.53,94.53,0,0,1-26.24,8.71,97.69,97.69,0,0,1-14.16,1.57c.5,1.61.9,3.25,1.25,4.9a53.27,53.27,0,0,1,1.14,12V217h.05a84.41,84.41,0,0,0,25.35-5.55,81,81,0,0,0,26.39-16.82c.8-.77,1.5-1.56,2.26-2.34a82.08,82.08,0,0,0,7.93-9.38A63.76,63.76,0,0,0,333,172.17a48.55,48.55,0,0,0,4.32-16.45c.09-1.23.2-2.47.19-3.7V150q-1.08,1.54-2.25,3.09A96.73,96.73,0,0,1,327,162.45Zm0,77.92c-.69.7-1.31,1.41-2,2.1a94.2,94.2,0,0,1-60.2,25.86h0l0,26.67h0a81.6,81.6,0,0,0,51.74-22.37A73.51,73.51,0,0,0,333,250.13a48.56,48.56,0,0,0,4.32-16.44c.09-1.24.2-2.47.19-3.71v-2.19c-.74,1.07-1.46,2.15-2.27,3.21A95.68,95.68,0,0,1,327,240.37Zm0-39c-.69.7-1.31,1.41-2,2.1a93.18,93.18,0,0,1-10.63,8.65,91.63,91.63,0,0,1-11.63,7,95.47,95.47,0,0,1-37.94,10.18h0V256h0a81.65,81.65,0,0,0,51.74-22.37c.8-.77,1.5-1.56,2.26-2.34a82.08,82.08,0,0,0,7.93-9.38A63.76,63.76,0,0,0,333,211.15a48.56,48.56,0,0,0,4.32-16.44c.09-1.24.2-2.48.19-3.71v-2.2c-.74,1.08-1.46,2.16-2.27,3.22A95.68,95.68,0,0,1,327,201.39Z" className="cls-1"/>
      </svg>
      </div>
    )
  },
  {
    name: "Command Line",
    color: "#000000",
    // Terminal icon from public folder
    icon: (
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
        <path d="M13 17H20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M5 7L10 12L5 17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    )
  },
  {
    name: "Workflows",
    color: "#FF9800",
    // Workflows/Tools icon
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
        <path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/>
      </svg>
    )
  },
  {
    name: "PagerDuty",
    color: "#06AC38",
    // PagerDuty logo
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
        <path d="M16.965 1.18C15.085.164 13.769 0 10.683 0H3.73v14.55h6.926c2.743 0 4.8-.164 6.639-1.328 1.99-1.282 3.022-3.418 3.022-6.14 0-2.791-1.207-4.839-3.352-5.902zM10.232 10.8H8.14V3.756h2.258c3.142 0 4.922.901 4.922 3.418 0 2.721-1.78 3.627-5.088 3.627zM3.73 24h4.41v-6.705H3.73z"/>
      </svg>
    )
  },
  {
    name: "Linux",
    color: "#FFFFFF",
    // Linux logo from public folder
    icon: (
      <div className="w-full h-full flex items-center justify-center" style={{ transform: 'scale(1.4)' }}>
        <Image src="/linux.svg" alt="Linux" width={128} height={128} className="w-full h-full object-contain" />
      </div>
    )
  },
  {
    name: "VictorOps",
    color: "#fbb040",
    // VictorOps / Splunk On-Call logo
    icon: (
      <svg viewBox="0 0 64 64" fill="#2d2d2d" className="w-full h-full">
        <path d="M25.92 45.6l5.36 6.24v7.36h1.36v-7.36l5.28-6.24-1.92.88.4-1.36 4.48-2 .24-1.44 3.6-4.56-7.12 2.32.16-1.6 9.44-4.8-2.08-3.68 4.4-6.32-12.32 5.92-.24-1.76 3.6-5.92-.48-.96 1.6-6.88-6.4 6.8-.4-3.76 1.92-5.68-2.56.88-2.32-6.88-2.24 6.88-2.56-.88 1.92 5.68-.4 3.76-6.48-6.8 1.68 6.88-.48.96 3.6 5.92-.24 1.76-12.4-5.92 4.48 6.32-2.08 3.68 9.44 4.8.16 1.6-7.2-2.32 3.6 4.56.32 1.44 4.4 2 .48 1.36z"/>
      </svg>
    )
  },
];

export function IntegrationOrbit() {
  // Filter integrations based on config
  const filteredIntegrations = useMemo(() => {
    const enabledIcons = getConfig('enabledIntegrationIcons');
    if (!enabledIcons) {
      // Show all icons if not configured
      return integrations;
    }
    // Filter to only show enabled icons (case-insensitive match)
    return integrations.filter((integration) =>
      enabledIcons.includes(integration.name.toLowerCase())
    );
  }, []);

  // Split filtered integrations between outer and inner orbits
  const outerOrbit = useMemo(() => {
    const count = Math.min(8, Math.ceil(filteredIntegrations.length * 0.55));
    return filteredIntegrations.slice(0, count);
  }, [filteredIntegrations]);

  const innerOrbit = useMemo(() => {
    const outerCount = Math.min(8, Math.ceil(filteredIntegrations.length * 0.55));
    return filteredIntegrations.slice(outerCount);
  }, [filteredIntegrations]);

  return (
    <div className="relative w-[400px] h-[400px] flex items-center justify-center">
      {/* Subtle center glow only - blends with page background */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-primary/10 via-transparent to-transparent opacity-50" />

      {/* Connecting lines animation */}
      <svg className="absolute inset-0 w-full h-full" style={{ zIndex: 0 }}>
        <defs>
          <linearGradient id="lineGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" style={{ stopColor: 'var(--gradient-from)', stopOpacity: 0.3 }} />
            <stop offset="50%" style={{ stopColor: 'var(--gradient-to)', stopOpacity: 0.5 }} />
            <stop offset="100%" style={{ stopColor: 'var(--gradient-from)', stopOpacity: 0.3 }} />
          </linearGradient>
        </defs>
        {/* Animated orbit rings */}
        <motion.circle
          cx="50%"
          cy="50%"
          r="120"
          fill="none"
          stroke="url(#lineGradient)"
          strokeWidth="1"
          strokeDasharray="8 4"
          initial={{ rotate: 0 }}
          animate={{ rotate: 360 }}
          transition={{ duration: 60, repeat: Infinity, ease: "linear" }}
        />
        <motion.circle
          cx="50%"
          cy="50%"
          r="175"
          fill="none"
          stroke="url(#lineGradient)"
          strokeWidth="1"
          strokeDasharray="12 6"
          initial={{ rotate: 0 }}
          animate={{ rotate: -360 }}
          transition={{ duration: 90, repeat: Infinity, ease: "linear" }}
        />
      </svg>

      {/* Center CAIPE Logo */}
      <motion.div
        className="absolute z-20 w-24 h-24 rounded-2xl gradient-primary-br flex items-center justify-center shadow-2xl shadow-primary/50"
        animate={{
          scale: [1, 1.05, 1],
          boxShadow: [
            "0 0 30px rgba(var(--primary), 0.3)",
            "0 0 50px rgba(var(--primary), 0.5)",
            "0 0 30px rgba(var(--primary), 0.3)",
          ],
        }}
        transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
      >
        <BrandLogo
          alt={getConfig('appName')}
          className="w-14 h-14"
          logoStyle={getConfig('logoStyle')}
          size={56}
          themed={getConfig('logoThemed')}
          src={getConfig('logoUrl')}
          variant="on-accent"
        />
      </motion.div>

      {/* Inner Orbit - closer integrations */}
      <div className="absolute w-[240px] h-[240px]">
        <motion.div
          className="w-full h-full"
          animate={{ rotate: 360 }}
          transition={{ duration: 30, repeat: Infinity, ease: "linear" }}
          style={{ transformOrigin: "center" }}
        >
          {innerOrbit.map((integration, index) => {
            const angle = (index * 360) / innerOrbit.length;
            const x = Math.cos((angle * Math.PI) / 180) * 120;
            const y = Math.sin((angle * Math.PI) / 180) * 120;

            return (
              <motion.div
                key={integration.name}
                className="absolute"
                style={{
                  left: `calc(50% + ${x}px - 22px)`,
                  top: `calc(50% + ${y}px - 22px)`,
                  transformOrigin: "center",
                }}
                animate={{ rotate: -360 }}
                transition={{ duration: 30, repeat: Infinity, ease: "linear" }}
                whileHover={{ scale: 1.3, zIndex: 50 }}
              >
                <motion.div
                  className="w-11 h-11 rounded-xl flex items-center justify-center shadow-lg cursor-pointer group"
                  style={{ backgroundColor: integration.color }}
                  whileHover={{
                    boxShadow: `0 0 20px ${integration.color}80`,
                  }}
                  title={integration.name}
                >
                  <div className="w-6 h-6 text-white">
                    {integration.icon}
                  </div>
                </motion.div>
              </motion.div>
            );
          })}
        </motion.div>
      </div>

      {/* Outer Orbit - wider spread */}
      <div className="absolute w-[350px] h-[350px]">
        <motion.div
          className="w-full h-full"
          animate={{ rotate: -360 }}
          transition={{ duration: 45, repeat: Infinity, ease: "linear" }}
          style={{ transformOrigin: "center" }}
        >
          {outerOrbit.map((integration, index) => {
            const angle = (index * 360) / outerOrbit.length + 30; // Offset from inner
            const x = Math.cos((angle * Math.PI) / 180) * 175;
            const y = Math.sin((angle * Math.PI) / 180) * 175;

            return (
              <motion.div
                key={integration.name}
                className="absolute"
                style={{
                  left: `calc(50% + ${x}px - 24px)`,
                  top: `calc(50% + ${y}px - 24px)`,
                  transformOrigin: "center",
                }}
                animate={{ rotate: 360 }}
                transition={{ duration: 45, repeat: Infinity, ease: "linear" }}
                whileHover={{ scale: 1.3, zIndex: 50 }}
              >
                <motion.div
                  className="w-12 h-12 rounded-xl flex items-center justify-center shadow-lg cursor-pointer"
                  style={{ backgroundColor: integration.color }}
                  whileHover={{
                    boxShadow: `0 0 25px ${integration.color}80`,
                  }}
                  title={integration.name}
                >
                  <div className="w-7 h-7 text-white">
                    {integration.icon}
                  </div>
                </motion.div>
              </motion.div>
            );
          })}
        </motion.div>
      </div>

      {/* Floating particles - using deterministic positions based on index to avoid hydration mismatch */}
      {[...Array(8)].map((_, i) => {
        // Deterministic pseudo-random values based on index
        const seed = (i * 17 + 7) % 100;
        const left = 20 + (seed * 0.6);
        const top = 20 + (((i * 31 + 13) % 100) * 0.6);
        const duration = 2 + (i % 3);
        const delay = (i * 0.25);

        return (
          <motion.div
            key={i}
            className="absolute w-1 h-1 rounded-full bg-primary/50"
            style={{
              left: `${left}%`,
              top: `${top}%`,
            }}
            animate={{
              y: [0, -20, 0],
              opacity: [0.3, 0.8, 0.3],
              scale: [1, 1.5, 1],
            }}
            transition={{
              duration,
              repeat: Infinity,
              delay,
            }}
          />
        );
      })}
    </div>
  );
}
